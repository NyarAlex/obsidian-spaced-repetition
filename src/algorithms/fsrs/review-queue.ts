import { debug } from "console";
import { App, moment, TFile } from "obsidian";

export class ReviewQueue {
    private app: App;
    private folderPath: string;
    public queue: TFile[] = [];
    private tagPriorityMapping: Record<string, number> = {};

    constructor(app: App, folderPath = "extracted") {
        this.app = app;
        this.folderPath = folderPath;
    }

    //重新读取一次tag对应优先级的映射关系
    private async readTagPriorityMapping(): Promise<Record<string, number>> {
        const file = this.app.vault.getFileByPath("SRmeta/优先级设计.md");
        const metadata = this.app.metadataCache.getFileCache(file);
        const frontmatter = metadata?.frontmatter;

        if (!frontmatter) {
            console.warn(`No frontmatter in file: ${file.path}`);
            return {};
        }

        const result = new Map<string, number>();
        for (const [key, value] of Object.entries(frontmatter)) {
            const num = typeof value === "string" ? parseFloat(value) : value;
            if (!isNaN(num)) {
                result.set(key, num);
            }
        }
        return Object.fromEntries(result);
    }

    //引入一个优先级计算函数
    private async calculatePriority(file: TFile): Promise<number> {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return 0;

        const tagsSet = new Set<string>();

        // 1. 提取 frontmatter 中的 tags（数组或单个）
        const fm = cache.frontmatter;
        if (fm) {
            const fmTags = fm.tags;
            if (typeof fmTags === "string") {
                tagsSet.add(fmTags.startsWith("#") ? fmTags : `#${fmTags}`);
            } else if (Array.isArray(fmTags)) {
                for (const tag of fmTags) {
                    tagsSet.add(tag.startsWith("#") ? tag : `#${tag}`);
                }
            }
        }
        let priority = 0;
        for (const tag of tagsSet) {
            //先检验是否存在tag对应映射,如果不存在则跳过
            if (this.tagPriorityMapping.hasOwnProperty(tag)) {
                priority += this.tagPriorityMapping[tag] ? this.tagPriorityMapping[tag] : 0;
            }
        }
        //加上时间衰退因子. 计算当前时间和最后复习时间直接的天数*P_TIME
        if (this.tagPriorityMapping["@P_TIME"]) {
            const lastReviewDate = moment(fm["wsr-last-review-date"], "YYYY-MM-DD");
            const now = window.moment().startOf("day");
            const daysSinceLastReview = now.diff(lastReviewDate, "days");
            priority += daysSinceLastReview * this.tagPriorityMapping["@P_TIME"] || 0;
        }
        return priority;
    }

    // 🔄 主更新逻辑：扫描、筛选、排序
    async update() {
        //更新tag对应优先级的映射关系
        this.tagPriorityMapping = await this.readTagPriorityMapping();
        const files = this.app.vault.getMarkdownFiles();
        const now = window.moment().startOf("day");

        const reviewCards: TFile[] = [];

        for (const file of files) {
            if (!file.path.startsWith(`${this.folderPath}/`)) continue;

            const content = await this.app.vault.read(file);

            // 必须含有 #review 标签
            if (!content.includes("#review")) continue;

            const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
            if (!frontmatterMatch) continue;

            const frontmatter = frontmatterMatch[1];
            const dueMatch = frontmatter.match(/wsr-due-date:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
            if (!dueMatch) continue;

            const dueDate = moment(dueMatch[1], "YYYY-MM-DD");

            if (dueDate.isSameOrBefore(now)) {
                reviewCards.push(file);
            }
        }
        debugger;
        this.queue = await Promise.all(
            reviewCards.map(async (card) => ({
                file: card,
                priority: await this.calculatePriority(card),
            })),
        ).then((cards) =>
            //优先级高的排在前面
            cards.sort((a, b) => b.priority - a.priority).map((card) => card.file),
        );
        console.log("review queue", this.queue);
    }
    // 取出下一个待复习卡片
    getNext(): TFile | undefined {
        return this.queue[0];
    }
}
