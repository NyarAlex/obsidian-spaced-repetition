import { App, TFile } from "obsidian";
import { fsrs, generatorParameters, createEmptyCard, Rating, formatDate, GradeType } from "ts-fsrs"; // 假设你用的库
import { Card as FSRSCard } from "ts-fsrs"; // FSRS 的卡片类型
import { formatDate as formatDateToString } from "src/utils/dates";
import { PREFERRED_DATE_FORMAT } from "src/constants";

// 初始化FSRS算法参数（可根据需要调整）
const params = generatorParameters({ enable_fuzz: true, enable_short_term: true });
const f = fsrs(params);

/**
 * 生成本地时间戳ID
 * @param date
 * @returns
 */
export function generateLocalTimeId(date: Date = new Date()): string {
    const year = date.getFullYear(); // 2025
    const month = (date.getMonth() + 1).toString().padStart(2, "0"); // 01~12
    const day = date.getDate().toString().padStart(2, "0"); // 01~31
    const hours = date.getHours().toString().padStart(2, "0"); // 00~23
    const minutes = date.getMinutes().toString().padStart(2, "0"); // 00~59
    const seconds = date.getSeconds().toString().padStart(2, "0"); // 00~59
    const millis = date.getMilliseconds().toString().padStart(3, "0"); // 000~999

    const timestamp = `${year}${month}${day}${hours}${minutes}${seconds}${millis}`;
    return `ID-${timestamp}`;
}

export function convertGradeTypeToRating(gradeType: GradeType): Rating {
    switch (gradeType) {
        case "Again":
            return Rating.Again;
        case "Hard":
            return Rating.Hard;
        case "Good":
            return Rating.Good;
        case "Easy":
            return Rating.Easy;
    }
}

export function updateTagsInRawFrontmatter(content: string, tags: Set<string>): string {
    const newTagsLine = `tags: [${Array.from(tags)
        .map((t) => `"${t}"`)
        .join(", ")}]`;

    if (/^tags:.*$/m.test(content)) {
        // 替换已有的 tags 行
        return content.replace(/^tags:.*$/m, newTagsLine);
    }

    // 如果没有 tags 行，插入到 frontmatter 开头（after ---）
    return content.replace(/^---\n/, `---\n${newTagsLine}\n`);
}

/**
 * 从文本内容中提取字段，构建 FSRSCard 对象
 * @param content 文本内容
 * @returns FSRSCard
 */
export function parseFsrsCardFromContent(content: string): FSRSCard {
    // 1. 解析所有字段
    const lines = content.split("\n");
    const fieldMap: Record<string, string> = {};
    for (const line of lines) {
        const match = line.match(/^([\w-]+):\s*(.*)$/);
        if (match) {
            fieldMap[match[1]] = match[2];
        }
    }

    // 2. 构建 FSRSCard 对象
    // 你可以根据 ts-fsrs 的 Card 类型字段来补全
    const card: FSRSCard = {
        due: fieldMap["wsr-due-timestamp"]
            ? new Date(Number(fieldMap["wsr-due-timestamp"]))
            : new Date(),
        stability: fieldMap["wsr-stability"] ? Number(fieldMap["wsr-stability"]) : 0,
        difficulty: fieldMap["wsr-difficulty"] ? Number(fieldMap["wsr-difficulty"]) : 0,
        elapsed_days: fieldMap["wsr-elapsed-days"] ? Number(fieldMap["wsr-elapsed-days"]) : 0,
        scheduled_days: fieldMap["wsr-scheduled-days"] ? Number(fieldMap["wsr-scheduled-days"]) : 0,
        learning_steps: fieldMap["wsr-learning-steps"] ? Number(fieldMap["wsr-learning-steps"]) : 0,
        reps: fieldMap["wsr-reps"] ? Number(fieldMap["wsr-reps"]) : 0,
        lapses: fieldMap["wsr-lapses"] ? Number(fieldMap["wsr-lapses"]) : 0,
        state: fieldMap["wsr-state"] ? Number(fieldMap["wsr-state"]) : 0,
        last_review: fieldMap["wsr-last-review-timestamp"]
            ? new Date(Number(fieldMap["wsr-last-review-timestamp"]))
            : new Date(),
    } as FSRSCard;

    return card;
}

/**
 * 根据路径读取文件内容
 * @param app
 * @param path 文件路径
 * @returns 文件内容
 */
export async function readFileContentByPath(app: App, path: string): Promise<string | null> {
    const file = app.vault.getAbstractFileByPath(path);

    if (file instanceof TFile) {
        const content = await app.vault.read(file);
        return content;
    } else {
        return "";
    }
}

/**
 * 用 card 对象批量替换文档中的 wsr-调度信息
 * @param content 原始文档内容
 * @param card FSRS 卡片对象
 * @param parentNode 可选，父节点字符串
 * @returns 替换后的文档内容
 */
export function updateWsrFieldsInContent(
    content: string,
    card: FSRSCard,
    parentNode?: string,
): string {
    // 字段与card属性的映射
    const fieldMap: Record<string, string | number> = {
        "wsr-due-date": card.due ? formatDateToString(card.due, PREFERRED_DATE_FORMAT) : "",
        "wsr-due-timestamp": card.due.getTime(),
        "wsr-stability": card.stability,
        "wsr-difficulty": card.difficulty,
        "wsr-elapsed-days": card.elapsed_days,
        "wsr-scheduled-days": card.scheduled_days,
        "wsr-learning-steps": card.learning_steps,
        "wsr-reps": card.reps,
        "wsr-lapses": card.lapses,
        "wsr-state": card.state,
        "wsr-last-review-date": card.last_review
            ? formatDateToString(card.last_review, PREFERRED_DATE_FORMAT)
            : "",
        "wsr-last-review-timestamp": card.last_review ? card.last_review.getTime() : 0,
    };
    if (parentNode) {
        fieldMap["wsr-parentnode"] = `"[[${parentNode}]]"`;
    }

    // 依次替换每个字段
    let newContent = content;
    for (const [key, value] of Object.entries(fieldMap)) {
        // 匹配 wsr-xxx: ...（允许前后有空格）
        const reg = new RegExp(`^(${key}:\\s*).*$`, "m");
        if (reg.test(newContent)) {
            newContent = newContent.replace(reg, `$1${value}`);
        }
    }
    return newContent;
}

/**
 * 创建一个新的FSRS卡片
 * @param now 当前时间（Date类型）
 * @returns 新的FSRS卡片对象
 */
export function createNewFsrsCard(now: Date): FSRSCard {
    return createEmptyCard(now);
}

/**
 * 传入card和当前时间，返回FSRS调度后的新card
 * @param card 需要调度的FSRS卡片对象
 * @param now 当前时间（Date类型）
 * @param rating 用户反馈（Rating.Again/Hard/Good/Easy），可选，默认Good
 * @returns 调度后的新card对象
 */
export function scheduleFsrsCard(
    card: FSRSCard,
    now: Date,
    rating: Rating = Rating.Good,
): FSRSCard {
    // repeat返回所有可能的评分结果，选取指定rating的结果
    const scheduling_cards = f.repeat(card, now);
    // 找到对应评分的调度结果
    const result = Array.from(scheduling_cards).find(
        (item: { log: { rating: Rating } }) => item.log.rating === rating,
    );
    if (!result) {
        throw new Error("未找到对应评分的调度结果");
    }
    return result.card;
}
