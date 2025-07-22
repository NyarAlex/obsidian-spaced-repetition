import { around } from "monkey-around";
import {
    Editor,
    MarkdownView,
    Menu,
    Notice,
    Plugin,
    TAbstractFile,
    TFile,
    TFolder,
    WorkspaceLeaf,
} from "obsidian";
import { GradeType, Rating } from "ts-fsrs";

import { ReviewResponse } from "src/algorithms/base/repetition-item";
import { SrsAlgorithm } from "src/algorithms/base/srs-algorithm";
import {
    batchAddTagsToFile,
    convertGradeTypeToRating,
    createNewFsrsCard,
    generateLocalTimeId,
    parseFsrsCardFromContent,
    readFileContentByPath,
    scheduleFsrsCard,
    updateTagsInRawFrontmatterToContent,
    updateWsrFieldsInContent,
} from "src/algorithms/fsrs/fsrs";
import { ObsidianVaultNoteLinkInfoFinder } from "src/algorithms/osr/obsidian-vault-notelink-info-finder";
import { SrsAlgorithmOsr } from "src/algorithms/osr/srs-algorithm-osr";
import { OsrAppCore } from "src/core";
import { DataStoreAlgorithm } from "src/data-store-algorithm/data-store-algorithm";
import { DataStoreInNoteAlgorithmOsr } from "src/data-store-algorithm/data-store-in-note-algorithm-osr";
import { DataStore } from "src/data-stores/base/data-store";
import { StoreInNotes } from "src/data-stores/notes/notes";
import { CardListType, Deck, DeckTreeFilter } from "src/deck";
import {
    CardOrder,
    DeckOrder,
    DeckTreeIterator,
    IDeckTreeIterator,
    IIteratorOrder,
} from "src/deck-tree-iterator";
import { ISRFile, SrTFile } from "src/file";
import {
    FlashcardReviewMode,
    FlashcardReviewSequencer,
    IFlashcardReviewSequencer,
} from "src/flashcard-review-sequencer";
import { REVIEW_QUEUE_VIEW_TYPE } from "src/gui/review-queue-list-view";
import { SRSettingTab } from "src/gui/settings";
import { OsrSidebar } from "src/gui/sidebar";
import { FlashcardModal } from "src/gui/sr-modal";
import { SRTabView } from "src/gui/sr-tab-view";
import TabViewManager from "src/gui/tab-view-manager";
import { appIcon } from "src/icons/app-icon";
import { t } from "src/lang/helpers";
import { NextNoteReviewHandler } from "src/next-note-review-handler";
import { Note } from "src/note";
import { NoteFileLoader } from "src/note-file-loader";
import { NoteReviewQueue } from "src/note-review-queue";
import { setDebugParser } from "src/parser";
import { DEFAULT_DATA, PluginData } from "src/plugin-data";
import { QuestionPostponementList } from "src/question-postponement-list";
import { DEFAULT_SETTINGS, SettingsUtil, SRSettings, upgradeSettings } from "src/settings";
import { TopicPath } from "src/topic-path";
import { convertToStringOrEmpty, TextDirection } from "src/utils/strings";

import { ReviewQueue } from "./algorithms/fsrs/review-queue";
import { FourButtonModal } from "./gui/FourButtonModel";

declare module "obsidian" {
    interface App {
        commands: {
            commands: { [commandId: string]: { id: string; name: string; callback: () => void } };
            executeCommandById(commandId: string): boolean;
        };
    }
    interface FoldPosition {
        from: number;
        to: number;
    }
    interface FoldInfo {
        folds: FoldPosition[];
        lines: number;
    }
    interface MarkdownSubView {
        applyFoldInfo(foldInfo: FoldInfo): void;
        getFoldInfo(): FoldInfo | null;
    }
}

// 打开下一个复习卡片的辅助函数
export async function openNextReviewCard(app: any, globalReviewQueue: any) {
    const next = globalReviewQueue.getNext();
    if (!next) {
        new Notice("No due review cards found.");
        return;
    }
    //todo fix
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
        await view.leaf.openFile(next);
        new Notice(`Opened: ${next.basename}`);
    } else {
        new Notice("No active pane to open file.");
    }
}

export default class SRPlugin extends Plugin {
    public data: PluginData;
    public osrAppCore: OsrAppCore;
    public tabViewManager: TabViewManager;
    private osrSidebar: OsrSidebar;
    private nextNoteReviewHandler: NextNoteReviewHandler;

    //全局复习队列
    private globalReviewQueue: ReviewQueue;

    private ribbonIcon: HTMLElement | null = null;
    private statusBar: HTMLElement | null = null;
    private isSRInFocus: boolean = false;
    private fileMenuHandler: (
        menu: Menu,
        file: TAbstractFile,
        source: string,
        leaf?: WorkspaceLeaf,
    ) => void;

    // 插件加载生命周期入口
    async onload(): Promise<void> {
        // 启动时，关闭所有插件相关的tab视图，防止遗留空白窗口或异常
        this.tabViewManager = new TabViewManager(this);
        this.app.workspace.onLayoutReady(async () => {
            this.tabViewManager.closeAllTabViews();
        });

        this.globalReviewQueue = new ReviewQueue(this.app);
        // 加载插件数据（包括用户设置等）
        await this.loadPluginData();

        // 初始化笔记复习队列和下一个笔记复习处理器
        const noteReviewQueue = new NoteReviewQueue();
        this.nextNoteReviewHandler = new NextNoteReviewHandler(
            this.app,
            this.data.settings,
            noteReviewQueue,
        );

        // 初始化侧边栏
        this.osrSidebar = new OsrSidebar(this, this.data.settings, this.nextNoteReviewHandler);
        this.osrSidebar.init();
        // 布局准备好后激活复习队列面板，并自动同步数据
        this.app.workspace.onLayoutReady(async () => {
            await this.osrSidebar.activateReviewQueueViewPanel();
            setTimeout(async () => {
                if (!this.osrAppCore.syncLock) {
                    await this.sync();
                }
            }, 2000);
        });

        // 初始化问题延迟列表（用于暂缓某些卡片/笔记的复习）
        const questionPostponementList: QuestionPostponementList = new QuestionPostponementList(
            this,
            this.data.settings,
            this.data.buryList,
        );
        // 构建笔记链接关系分析器
        const osrNoteLinkInfoFinder: ObsidianVaultNoteLinkInfoFinder =
            new ObsidianVaultNoteLinkInfoFinder(this.app.metadataCache);

        // 初始化核心应用逻辑对象
        this.osrAppCore = new OsrAppCore(this.app);
        this.osrAppCore.init(
            questionPostponementList,
            osrNoteLinkInfoFinder,
            this.data.settings,
            this.onOsrVaultDataChanged.bind(this),
            noteReviewQueue,
        );

        // 注册插件图标
        appIcon();

        // 显示/隐藏状态栏
        this.showStatusBar(this.data.settings.showStatusBar);
        // 显示/隐藏功能区图标
        this.showRibbonIcon(this.data.settings.showRibbonIcon);
        // 注册文件菜单（右键菜单）
        this.showFileMenuItems(!this.data.settings.disableFileMenuReviewOptions);
        // 注册所有插件命令
        this.addPluginCommands();
        // 添加设置面板
        this.addSettingTab(new SRSettingTab(this.app, this));
        // 注册焦点监听（用于判断插件视图是否处于激活状态）
        this.registerSRFocusListener();
        // 注册文件打开监听
        this.registerFileOpenListener();
    }

    showFileMenuItems(status: boolean) {
        // define the handler if it was not defined yet
        if (this.fileMenuHandler === undefined) {
            this.fileMenuHandler = (menu, fileish: TAbstractFile) => {
                if (fileish instanceof TFile && fileish.extension === "md") {
                    menu.addItem((item) => {
                        item.setTitle(
                            t("REVIEW_DIFFICULTY_FILE_MENU", {
                                difficulty: this.data.settings.flashcardEasyText,
                            }),
                        )
                            .setIcon("SpacedRepIcon")
                            .onClick(() => {
                                this.saveNoteReviewResponse(fileish, ReviewResponse.Easy);
                            });
                    });

                    menu.addItem((item) => {
                        item.setTitle(
                            t("REVIEW_DIFFICULTY_FILE_MENU", {
                                difficulty: this.data.settings.flashcardGoodText,
                            }),
                        )
                            .setIcon("SpacedRepIcon")
                            .onClick(() => {
                                this.saveNoteReviewResponse(fileish, ReviewResponse.Good);
                            });
                    });

                    menu.addItem((item) => {
                        item.setTitle(
                            t("REVIEW_DIFFICULTY_FILE_MENU", {
                                difficulty: this.data.settings.flashcardHardText,
                            }),
                        )
                            .setIcon("SpacedRepIcon")
                            .onClick(() => {
                                this.saveNoteReviewResponse(fileish, ReviewResponse.Hard);
                            });
                    });
                }
            };
        }

        if (status) {
            this.registerEvent(this.app.workspace.on("file-menu", this.fileMenuHandler));
        } else {
            this.app.workspace.off("file-menu", this.fileMenuHandler);
        }
    }

    private addPluginCommands() {
        this.addCommand({
            id: "srs-note-review-open-note",
            name: t("OPEN_NOTE_FOR_REVIEW"),
            callback: async () => {
                if (!this.osrAppCore.syncLock) {
                    await this.sync();
                    this.nextNoteReviewHandler.reviewNextNoteModal();
                }
            },
        });
        //静默摘录
        this.addCommand({
            id: "extract-selection-to-note",
            name: "Extract selected text to new note",
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const selectedText = editor.getSelection();
                let newCard = createNewFsrsCard(new Date());
                //初始化卡片.跳过new阶段
                newCard = scheduleFsrsCard(newCard, new Date(), Rating.Good);
                //新创建的卡片安排到下一天复习
                newCard.due = new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
                if (!selectedText) {
                    new Notice("No text selected!");
                    return;
                }

                const title = `Extracted-${generateLocalTimeId()}`;
                const folder = "extracted"; // 你可以改成别的路径
                const filePath = `${folder}/${title}.md`;

                //content通过读取一个指定文件的内容来生成
                const content = await readFileContentByPath(this.app, "SRmeta/TP-SR-TEXT.md");
                if (!content) {
                    new Notice("Failed to read file content!");
                    return;
                }
                let newContent = updateWsrFieldsInContent(content, newCard, view.file.basename);

                //获取来源笔记的frontmatter中的tags,并设置到新卡片中
                let tags = new Set<string>();
                const sourceFile = view.file;
                const sourceCache = this.app.metadataCache.getFileCache(sourceFile);
                if (sourceCache) {
                    const sourceTags = sourceCache.frontmatter?.tags;
                    if (sourceTags) {
                        tags = new Set(
                            sourceTags.map((tag: string) =>
                                tag.startsWith("#") ? tag : `#${tag}`,
                            ),
                        );
                        console.log("tags", tags);
                    }
                }
                //检查tags里是否有#review,需要确保其存在，并给tags去重
                if (!tags.has("#review")) {
                    tags.add("#review");
                }
                //将tags设置到frontmatter中 tags的格式是tags: ["#review","#SR-TEXT"]这种
                newContent = updateTagsInRawFrontmatterToContent(newContent, tags);

                const wsrArgsRegex = /@TEXT@/;
                newContent = newContent.replace(wsrArgsRegex, selectedText);

                try {
                    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
                    if (existingFile) {
                        new Notice("File already exists!");
                        return;
                    }

                    await this.app.vault.create(filePath, newContent);
                    new Notice(`Created ${filePath}`);
                    //更新全局复习队列
                    await this.updateGlobalReviewQueue();
                } catch (err) {
                    console.error(err);
                    new Notice("Failed to create note");
                }
            },
        });
        //创建QA卡片
        this.addCommand({
            id: "extract-qa-note",
            name: "Extract selected text to new QA note",
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const selectedText = editor.getSelection();
                let newCard = createNewFsrsCard(new Date());
                //初始化卡片.跳过new阶段
                newCard = scheduleFsrsCard(newCard, new Date(), Rating.Good);
                //新创建的卡片安排到下一天复习
                newCard.due = new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
                if (!selectedText) {
                    new Notice("No text selected!");
                    return;
                }

                const title = `QA-${generateLocalTimeId()}`;
                const folder = "extracted"; // 你可以改成别的路径
                const filePath = `${folder}/${title}.md`;

                //content通过读取一个指定文件的内容来生成
                const content = await readFileContentByPath(this.app, "SRmeta/TP-SR-QACARD.md");
                if (!content) {
                    new Notice("Failed to read file content!");
                    return;
                }
                let newContent = updateWsrFieldsInContent(content, newCard, view.file.basename);

                //获取来源笔记的frontmatter中的tags,并设置到新卡片中
                let tags = new Set<string>();
                const sourceFile = view.file;
                const sourceCache = this.app.metadataCache.getFileCache(sourceFile);
                if (sourceCache) {
                    const sourceTags = sourceCache.frontmatter?.tags;
                    if (sourceTags) {
                        tags = new Set(
                            sourceTags.map((tag: string) =>
                                tag.startsWith("#") ? tag : `#${tag}`,
                            ),
                        );
                        console.log("tags", tags);
                    }
                }
                //检查tags里是否有#review,需要确保其存在，并给tags去重
                if (!tags.has("#review")) {
                    tags.add("#review");
                }
                //将tags设置到frontmatter中 tags的格式是tags: ["#review","#SR-TEXT"]这种
                newContent = updateTagsInRawFrontmatterToContent(newContent, tags);

                const wsrArgsRegex = /@TEXT@/g;
                newContent = newContent.replace(wsrArgsRegex, selectedText);

                try {
                    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
                    if (existingFile) {
                        new Notice("File already exists!");
                        return;
                    }

                    await this.app.vault.create(filePath, newContent);
                    new Notice(`Created ${filePath}`);
                    //更新全局复习队列
                    await this.updateGlobalReviewQueue();
                } catch (err) {
                    console.error(err);
                    new Notice("Failed to create note");
                }
            },
        });
        //显示复习状态弹窗
        this.addCommand({
            id: "show-button-modal",
            name: "Show Button Modal",
            callback: () => {
                new FourButtonModal(this.app, async (choice: GradeType) => {
                    new Notice(`You clicked: ${choice}`);
                    //获取当前文档里的wsr信息，用fsrs算法进行计算，然后更新文档
                    const openFile: TFile | null = this.app.workspace.getActiveFile();
                    const folderName = "extracted";
                    if (
                        openFile &&
                        openFile.extension === "md" &&
                        openFile.path.startsWith(`${folderName}/`)
                    ) {
                        const content = await this.app.vault.read(openFile);
                        if (!content) return;
                        const oldCard = parseFsrsCardFromContent(content);
                        const card = scheduleFsrsCard(
                            oldCard,
                            new Date(),
                            convertGradeTypeToRating(choice),
                        );
                        const newContent = updateWsrFieldsInContent(content, card);
                        await this.app.vault.modify(openFile, newContent);
                        //更新全局复习队列
                        await this.updateGlobalReviewQueue();
                        //打开下一个复习卡片
                        await openNextReviewCard(this.app, this.globalReviewQueue);
                    }
                }).open();
            },
        });
        //dismiss当前笔记
        this.addCommand({
            id: "dismiss-current-note",
            name: "Dismiss current note",
            callback: async () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                const folderName = "extracted";
                if (
                    openFile &&
                    openFile.extension === "md" &&
                    openFile.path.startsWith(`${folderName}/`)
                ) {
                    const content = await this.app.vault.read(openFile);
                    if (!content) return;
                    //将文档中的 #review 修改为 #dismiss
                    const newContent = content.replace(/#review/, "#dismiss");
                    await this.app.vault.modify(openFile, newContent);
                    //更新全局复习队列
                    await this.updateGlobalReviewQueue();
                    //打开下一个复习卡片
                    await openNextReviewCard(this.app, this.globalReviewQueue);
                }
            },
        });
        this.addCommand({
            id: "open-next-review-card",
            name: "Open Next Review Card",
            callback: async () => {
                await this.globalReviewQueue.update();
                await openNextReviewCard(this.app, this.globalReviewQueue);
            },
        });

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (!file) {
                    return;
                }
                // Add our custom menu item
                menu.addItem((item) => {
                    item.setTitle("批量添加Tag") // The text that appears in the menu
                        .setIcon("tag") // Sets a tag icon for the command
                        .onClick(() => {
                            if ("children" in file) {
                                batchAddTagsToFile(this.app, file as TFolder, new Set());
                            } else {
                                batchAddTagsToFile(this.app, file as TFile, new Set());
                            }
                        });
                });
            }),
        );

        this.addCommand({
            id: "srs-note-review-easy",
            name: t("REVIEW_NOTE_DIFFICULTY_CMD", {
                difficulty: this.data.settings.flashcardEasyText,
            }),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveNoteReviewResponse(openFile, ReviewResponse.Easy);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-good",
            name: t("REVIEW_NOTE_DIFFICULTY_CMD", {
                difficulty: this.data.settings.flashcardGoodText,
            }),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveNoteReviewResponse(openFile, ReviewResponse.Good);
                }
            },
        });

        this.addCommand({
            id: "srs-note-review-hard",
            name: t("REVIEW_NOTE_DIFFICULTY_CMD", {
                difficulty: this.data.settings.flashcardHardText,
            }),
            callback: () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (openFile && openFile.extension === "md") {
                    this.saveNoteReviewResponse(openFile, ReviewResponse.Hard);
                }
            },
        });

        this.addCommand({
            id: "srs-review-flashcards",
            name: t("REVIEW_ALL_CARDS"),
            callback: async () => {
                if (this.osrAppCore.syncLock) {
                    return;
                }
                await this.sync();

                if (this.data.settings.openViewInNewTab) {
                    this.tabViewManager.openSRTabView(this.osrAppCore, FlashcardReviewMode.Review);
                } else {
                    this.openFlashcardModal(
                        this.osrAppCore.reviewableDeckTree,
                        this.osrAppCore.remainingDeckTree,
                        FlashcardReviewMode.Review,
                    );
                }
            },
        });

        this.addCommand({
            id: "srs-cram-flashcards",
            name: t("CRAM_ALL_CARDS"),
            callback: async () => {
                await this.sync();
                if (this.data.settings.openViewInNewTab) {
                    this.tabViewManager.openSRTabView(this.osrAppCore, FlashcardReviewMode.Cram);
                } else {
                    this.openFlashcardModal(
                        this.osrAppCore.reviewableDeckTree,
                        this.osrAppCore.reviewableDeckTree,
                        FlashcardReviewMode.Cram,
                    );
                }
            },
        });

        this.addCommand({
            id: "srs-review-flashcards-in-note",
            name: t("REVIEW_CARDS_IN_NOTE"),
            callback: async () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (!openFile || openFile.extension !== "md") {
                    return;
                }

                if (this.data.settings.openViewInNewTab) {
                    this.tabViewManager.openSRTabView(
                        this.osrAppCore,
                        FlashcardReviewMode.Review,
                        openFile,
                    );
                } else {
                    this.openFlashcardModalForSingleNote(openFile, FlashcardReviewMode.Review);
                }
            },
        });

        this.addCommand({
            id: "srs-cram-flashcards-in-note",
            name: t("CRAM_CARDS_IN_NOTE"),
            callback: async () => {
                const openFile: TFile | null = this.app.workspace.getActiveFile();
                if (!openFile || openFile.extension !== "md") {
                    return;
                }

                if (this.data.settings.openViewInNewTab) {
                    this.tabViewManager.openSRTabView(
                        this.osrAppCore,
                        FlashcardReviewMode.Cram,
                        openFile,
                    );
                } else {
                    this.openFlashcardModalForSingleNote(openFile, FlashcardReviewMode.Cram);
                }
            },
        });

        this.addCommand({
            id: "srs-open-review-queue-view",
            name: t("OPEN_REVIEW_QUEUE_VIEW"),
            callback: async () => {
                await this.osrSidebar.openReviewQueueView();
            },
        });
    }

    onunload(): void {
        this.app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW_TYPE).forEach((leaf) => leaf.detach());
        this.tabViewManager.closeAllTabViews();
    }

    public getPreparedReviewSequencer(
        fullDeckTree: Deck,
        remainingDeckTree: Deck,
        reviewMode: FlashcardReviewMode,
    ): { reviewSequencer: IFlashcardReviewSequencer; mode: FlashcardReviewMode } {
        const deckIterator: IDeckTreeIterator = SRPlugin.createDeckTreeIterator(this.data.settings);

        const reviewSequencer: IFlashcardReviewSequencer = new FlashcardReviewSequencer(
            reviewMode,
            deckIterator,
            this.data.settings,
            SrsAlgorithm.getInstance(),
            this.osrAppCore.questionPostponementList,
            this.osrAppCore.dueDateFlashcardHistogram,
        );

        reviewSequencer.setDeckTree(fullDeckTree, remainingDeckTree);
        return { reviewSequencer, mode: reviewMode };
    }

    public async getPreparedDecksForSingleNoteReview(
        file: TFile,
        mode: FlashcardReviewMode,
    ): Promise<{ deckTree: Deck; remainingDeckTree: Deck; mode: FlashcardReviewMode }> {
        const note: Note = await this.loadNote(file);

        const deckTree = new Deck("root", null);
        note.appendCardsToDeck(deckTree);
        const remainingDeckTree = DeckTreeFilter.filterForRemainingCards(
            this.osrAppCore.questionPostponementList,
            deckTree,
            mode,
        );

        return { deckTree, remainingDeckTree, mode };
    }

    public registerSRFocusListener() {
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", this.handleFocusChange.bind(this)),
        );
    }
    public registerFileOpenListener() {
        this.registerEvent(
            this.app.workspace.on("file-open", (file: TFile | null) => {
              if (!file) return;

              const folderName = "extracted"; // 替换为你的文件夹名称
                // 如果文件在extracted文件夹中，则折叠frontmatter
             if(file.path.startsWith(`${folderName}/`)){
              const currentLeaf = document.querySelector('.workspace-leaf.mod-active')
              if (currentLeaf) {
                  const propertiesAreFolded = currentLeaf.querySelector('.metadata-container.is-collapsed')
                  if (!propertiesAreFolded) {
                      this.app.commands.executeCommandById('editor:toggle-fold-properties');
                  }
              }
            }
            // debugger;
            })
        );

        // const leaf = this.app.workspace.getLeaf();
        // if (!leaf) return;
        // const view = leaf.view as MarkdownView;
        // if (!view) return;

        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return;
        //直接hook onLoadFile方法，也就是在加载文件内容后控制折叠属性
        this.register(
            around(view.constructor.prototype, {
                onLoadFile(old: (file: TFile) => void) {
                    return async function (file: TFile) {
                        await old.call(this, file);
                        const folderName = "extracted";
                        const folds: [number, number][] = [];
                        // console.log("onLoadFile 行数: ", view.editor.lineCount());
                        // //处理frontmatter的折叠
                        // if (file.path.startsWith(`${folderName}/`)) {
                        //     let startLine = -1;
                        //     let endLine = -1;
                        //     for (let i = 0; i < view.editor.lineCount(); i++) {
                        //         const line = view.editor.getLine(i);
                        //         if (
                        //             startLine == -1 &&
                        //             line.trim().toLowerCase().startsWith("---")
                        //         ) {
                        //             startLine = i;
                        //             continue;
                        //         }
                        //         if (
                        //             startLine != -1 &&
                        //             line.trim().toLowerCase().startsWith("---")
                        //         ) {
                        //             endLine = i;
                        //             break;
                        //         }
                        //     }
                        //     if (startLine != -1 && endLine != -1) {
                        //         folds.push([startLine, endLine]);
                        //     }
                        // }
                        //处理answer的折叠
                        if (file.path.startsWith(`${folderName}/QA-`)) {
                            for (let i = 0; i < view.editor.lineCount(); i++) {
                                const line = view.editor.getLine(i);
                                if (line.trim().toLowerCase().startsWith("## answer")) {
                                    folds.push([i, view.editor.lineCount()]);
                                    break;
                                }
                            }
                        }

                        if (folds.length > 0) {
                            view.currentMode.applyFoldInfo({
                                folds: folds.map(([from, to]) => ({ from, to })),
                                lines: view.editor.lineCount(),
                            });
                        }
                    };
                },
            }),
        );
    }

    public removeSRFocusListener() {
        this.setSRViewInFocus(false);
        this.app.workspace.off("active-leaf-change", this.handleFocusChange.bind(this));
    }

    public handleFocusChange(leaf: WorkspaceLeaf | null) {
        this.setSRViewInFocus(leaf !== null && leaf.view instanceof SRTabView);
    }

    public setSRViewInFocus(value: boolean) {
        this.isSRInFocus = value;
    }

    public getSRInFocusState(): boolean {
        return this.isSRInFocus;
    }

    private async openFlashcardModalForSingleNote(
        noteFile: TFile,
        reviewMode: FlashcardReviewMode,
    ): Promise<void> {
        const singleNoteDeckData = await this.getPreparedDecksForSingleNoteReview(
            noteFile,
            reviewMode,
        );
        this.openFlashcardModal(
            singleNoteDeckData.deckTree,
            singleNoteDeckData.remainingDeckTree,
            reviewMode,
        );
    }
    private openFlashcardModal(
        fullDeckTree: Deck,
        remainingDeckTree: Deck,
        reviewMode: FlashcardReviewMode,
    ): void {
        const reviewSequencerData = this.getPreparedReviewSequencer(
            fullDeckTree,
            remainingDeckTree,
            reviewMode,
        );

        this.setSRViewInFocus(true);
        new FlashcardModal(
            this.app,
            this,
            this.data.settings,
            reviewSequencerData.reviewSequencer,
            reviewSequencerData.mode,
        ).open();
    }

    private static createDeckTreeIterator(settings: SRSettings): IDeckTreeIterator {
        let cardOrder: CardOrder = CardOrder[settings.flashcardCardOrder as keyof typeof CardOrder];
        if (cardOrder === undefined) cardOrder = CardOrder.DueFirstSequential;
        let deckOrder: DeckOrder = DeckOrder[settings.flashcardDeckOrder as keyof typeof DeckOrder];
        if (deckOrder === undefined) deckOrder = DeckOrder.PrevDeckComplete_Sequential;

        const iteratorOrder: IIteratorOrder = {
            deckOrder,
            cardOrder,
        };
        return new DeckTreeIterator(iteratorOrder, null);
    }
    async updateGlobalReviewQueue(): Promise<void> {
        await this.globalReviewQueue.update();
    }

    async sync(): Promise<void> {
        if (this.osrAppCore.syncLock) {
            return;
        }

        const now = window.moment(Date.now());
        this.osrAppCore.defaultTextDirection = this.getObsidianRtlSetting();

        await this.osrAppCore.loadVault();

        if (this.data.settings.showSchedulingDebugMessages) {
            console.log(`SR: ${t("DECKS")}`, this.osrAppCore.reviewableDeckTree);
            console.log(
                "SR: " +
                    t("SYNC_TIME_TAKEN", {
                        t: Date.now() - now.valueOf(),
                    }),
            );
        }
    }

    private onOsrVaultDataChanged() {
        this.statusBar.setText(
            t("STATUS_BAR", {
                dueNotesCount: this.osrAppCore.noteReviewQueue.dueNotesCount,
                dueFlashcardsCount: this.osrAppCore.remainingDeckTree.getCardCount(
                    CardListType.All,
                    true,
                ),
            }),
        );

        if (this.data.settings.enableNoteReviewPaneOnStartup) this.osrSidebar.redraw();
    }

    async loadNote(noteFile: TFile): Promise<Note> {
        const loader: NoteFileLoader = new NoteFileLoader(this.data.settings);
        const srFile: ISRFile = this.createSrTFile(noteFile);
        const folderTopicPath: TopicPath = TopicPath.getFolderPathFromFilename(
            srFile,
            this.data.settings,
        );

        const note: Note = await loader.load(
            this.createSrTFile(noteFile),
            this.getObsidianRtlSetting(),
            folderTopicPath,
        );
        if (note.hasChanged) {
            note.writeNoteFile(this.data.settings);
        }
        return note;
    }

    private getObsidianRtlSetting(): TextDirection {
        // Get the direction with Obsidian's own setting
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v: any = (this.app.vault as any).getConfig("rightToLeft");
        return convertToStringOrEmpty(v) == "true" ? TextDirection.Rtl : TextDirection.Ltr;
    }

    async saveNoteReviewResponse(note: TFile, response: ReviewResponse): Promise<void> {
        const noteSrTFile: ISRFile = this.createSrTFile(note);

        if (SettingsUtil.isPathInNoteIgnoreFolder(this.data.settings, note.path)) {
            new Notice(t("NOTE_IN_IGNORED_FOLDER"));
            return;
        }

        const tags = noteSrTFile.getAllTagsFromCache();
        if (!SettingsUtil.isAnyTagANoteReviewTag(this.data.settings, tags)) {
            new Notice(t("PLEASE_TAG_NOTE"));
            return;
        }

        //
        await this.osrAppCore.saveNoteReviewResponse(noteSrTFile, response, this.data.settings);

        new Notice(t("RESPONSE_RECEIVED"));

        if (this.data.settings.autoNextNote) {
            this.nextNoteReviewHandler.autoReviewNextNote();
        }
    }

    createSrTFile(note: TFile): SrTFile {
        return new SrTFile(this.app.vault, this.app.metadataCache, note);
    }

    async loadPluginData(): Promise<void> {
        const loadedData: PluginData = await this.loadData();
        if (loadedData?.settings) upgradeSettings(loadedData.settings);
        this.data = Object.assign({}, DEFAULT_DATA, loadedData);
        this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings);
        setDebugParser(this.data.settings.showParserDebugMessages);

        this.setupDataStoreAndAlgorithmInstances(this.data.settings);
    }

    setupDataStoreAndAlgorithmInstances(settings: SRSettings) {
        // For now we can hardcode as we only support the one data store and one algorithm
        DataStore.instance = new StoreInNotes(settings);
        SrsAlgorithm.instance = new SrsAlgorithmOsr(settings);
        DataStoreAlgorithm.instance = new DataStoreInNoteAlgorithmOsr(settings);
    }
    async savePluginData(): Promise<void> {
        await this.saveData(this.data);
    }

    showRibbonIcon(status: boolean) {
        // if it does not exist, we create it
        if (!this.ribbonIcon) {
            this.ribbonIcon = this.addRibbonIcon("SpacedRepIcon", t("REVIEW_CARDS"), async () => {
                if (!this.osrAppCore.syncLock) {
                    await this.sync();
                    this.openFlashcardModal(
                        this.osrAppCore.reviewableDeckTree,
                        this.osrAppCore.remainingDeckTree,
                        FlashcardReviewMode.Review,
                    );
                }
            });
        }
        if (status) {
            this.ribbonIcon.style.display = "";
        } else {
            this.ribbonIcon.style.display = "none";
        }
    }

    showStatusBar(status: boolean) {
        // if it does not exist, we create it
        if (!this.statusBar) {
            this.statusBar = this.addStatusBarItem();
            this.statusBar.classList.add("mod-clickable");
            this.statusBar.setAttribute("aria-label", t("OPEN_NOTE_FOR_REVIEW"));
            this.statusBar.setAttribute("aria-label-position", "top");
            this.statusBar.addEventListener("click", async () => {
                if (!this.osrAppCore.syncLock) {
                    await this.sync();
                    this.nextNoteReviewHandler.reviewNextNoteModal();
                }
            });
        }

        if (status) {
            this.statusBar.style.display = "";
        } else {
            this.statusBar.style.display = "none";
        }
    }
}
