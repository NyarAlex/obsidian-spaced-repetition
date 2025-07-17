# Obsidian 间隔重复插件技术解析

## 概述

这个插件实现了一个完整的间隔重复学习系统，支持闪卡复习和整篇笔记复习。本文档详细解析插件的核心技术功能。

## 1. 文档识别与分类机制

### 1.1 文档扫描流程

```typescript
// 核心扫描方法：src/core.ts - OsrAppCore.loadVault()
async loadVault(): Promise<void> {
    if (this._syncLock) {
        return;
    }
    this._syncLock = true;

    try {
        this.loadInit();

        const notes: TFile[] = this.app.vault.getMarkdownFiles();
        for (const noteFile of notes) {
            if (SettingsUtil.isPathInNoteIgnoreFolder(this.settings, noteFile.path)) {
                continue;
            }

            const file: SrTFile = this.createSrTFile(noteFile);
            await this.processFile(file);
        }

        this.finaliseLoad();
    } finally {
        this._syncLock = false;
    }
}
```

### 1.2 文档分类逻辑

插件通过以下方式识别文档类型：

```typescript
// src/core.ts - processFile方法
protected async processFile(noteFile: ISRFile): Promise<void> {
    const schedule: RepItemScheduleInfo =
        await DataStoreAlgorithm.getInstance().noteGetSchedule(noteFile);
    let note: Note = null;

    // Update the graph of links between notes
    this.osrNoteGraph.processLinks(noteFile.path);

    // 检查文档是否包含闪卡标签
    const topicPath: TopicPath = this.findTopicPath(noteFile);
    if (topicPath.hasPath) {
        note = await this.loadNote(noteFile, topicPath);
        note.appendCardsToDeck(this.fullDeckTree);
    }

    SrsAlgorithm.getInstance().noteOnLoadedNote(noteFile.path, note, schedule?.latestEase);

    // 检查是否包含笔记复习标签
    const tags = noteFile.getAllTagsFromCache();
    const matchedNoteTags = SettingsUtil.filterForNoteReviewTag(this.settings, tags);
    if (matchedNoteTags.length == 0) {
        return;
    }
    const noteSchedule: RepItemScheduleInfo =
        await DataStoreAlgorithm.getInstance().noteGetSchedule(noteFile);
    this._noteReviewQueue.addNoteToQueue(noteFile, noteSchedule, matchedNoteTags);
}
```

## 2. 闪卡格式与解析流程详解

### 2.1 支持的闪卡格式

插件支持5种主要的闪卡格式：

```typescript
// src/settings.ts - 默认分隔符设置
const DEFAULT_SETTINGS: SRSettings = {
    singleLineCardSeparator: "::",           // 单行基础卡片
    singleLineReversedCardSeparator: ":::",  // 单行反转卡片
    multilineCardSeparator: "?",             // 多行基础卡片
    multilineReversedCardSeparator: "??",    // 多行反转卡片
    clozePatterns: ["==[123;;]answer[;;hint]=="], // 填空卡片模式
};
```

**具体格式示例：**

1. **单行基础卡片** (`::`)
```markdown
什么是间隔重复？::一种基于记忆曲线的学习方法
```

2. **单行反转卡片** (`:::`)
```markdown
牛顿:::万有引力定律的发现者
```
生成两张卡片：
- 牛顿 → 万有引力定律的发现者
- 万有引力定律的发现者 → 牛顿

3. **多行基础卡片** (`?`)
```markdown
解释什么是递归？
?
函数调用自身的编程技术，
需要有基本情况和递归情况
```

4. **多行反转卡片** (`??`)
```markdown
快速排序算法
??
分治法的典型应用，
平均时间复杂度O(n log n)
```

5. **填空卡片** (`==答案==`)
```markdown
光速在真空中的速度是 ==3×10^8 m/s==
```

### 2.2 解析流程架构

```typescript
// src/note-question-parser.ts - createQuestionList方法
async createQuestionList(
    noteFile: ISRFile,
    defaultTextDirection: TextDirection,
    folderTopicPath: TopicPath,
    onlyKeepQuestionsWithTopicPath: boolean,
): Promise<Question[]> {
    this.noteFile = noteFile;
    
    // 1. 首先检查是否包含闪卡标签（性能优化）
    const tagCacheList: string[] = noteFile.getAllTagsFromCache();
    const hasTopicPaths: boolean =
        tagCacheList.some((item) => SettingsUtil.isFlashcardTag(this.settings, item)) ||
        folderTopicPath.hasPath;

    if (hasTopicPaths) {
        // 2. 读取文件内容（仅在需要时）
        const noteText: string = await noteFile.read();
        const tagCompleteList: TagCache[] = noteFile.getAllTagsFromText();

        // 3. 分离前言和正文内容
        [this.frontmatterText, this.contentText] = splitNoteIntoFrontmatterAndContent(noteText);

        // 4. 创建问题列表
        let textDirection: TextDirection = noteFile.getTextDirection();
        if (textDirection == TextDirection.Unspecified) textDirection = defaultTextDirection;
        this.questionList = this.doCreateQuestionList(
            noteText,
            textDirection,
            folderTopicPath,
            this.tagCacheList,
        );

        // 5. 分析标签并确定主题路径
        [this.frontmatterTopicPathList, this.contentTopicPathInfo] =
            this.analyseTagCacheList(tagCompleteList);
        for (const question of this.questionList) {
            question.topicPathList = this.determineQuestionTopicPathList(question);
        }

        // 6. 过滤（如果需要）
        if (onlyKeepQuestionsWithTopicPath) {
            this.questionList = this.questionList.filter((q) => q.topicPathList);
        }
    } else {
        this.questionList = [] as Question[];
    }
    return this.questionList;
}
```

### 2.3 核心解析算法

```typescript
// src/parser.ts - parse函数
export function parse(text: string, options: ParserOptions): ParsedQuestionInfo[] {
    // 按长度排序分隔符，避免短分隔符被长分隔符包含的问题
    const inlineSeparators = [
        { separator: options.singleLineCardSeparator, type: CardType.SingleLineBasic },
        { separator: options.singleLineReversedCardSeparator, type: CardType.SingleLineReversed },
    ];
    inlineSeparators.sort((a, b) => b.separator.length - a.separator.length);

    const cards: ParsedQuestionInfo[] = [];
    let cardText = "";
    let cardType: CardType | null = null;
    let firstLineNo = 0, lastLineNo = 0;

    const clozecrafter = new ClozeCrafter(options.clozePatterns);
    const lines: string[] = text.replaceAll("\r\n", "\n").split("\n");
    
    for (let i = 0; i < lines.length; i++) {
        const currentLine = lines[i];
        const currentTrimmed = lines[i].trim();

        // 跳过HTML注释（除了SR调度信息）
        if (currentLine.startsWith("<!--") && !currentLine.startsWith("<!--SR:")) {
            while (i + 1 < lines.length && !currentLine.includes("-->")) i++;
            i++;
            continue;
        }

        // 检查是否到达卡片结束
        const isEmptyLine = currentTrimmed.length == 0;
        const hasMultilineCardEndMarker = 
            options.multilineCardEndMarker && currentTrimmed == options.multilineCardEndMarker;
        
        if ((isEmptyLine && !options.multilineCardEndMarker) || 
            (isEmptyLine && cardType == null) || 
            hasMultilineCardEndMarker) {
            
            if (cardType) {
                // 创建新卡片
                lastLineNo = i - 1;
                cards.push(new ParsedQuestionInfo(cardType, cardText.trimEnd(), firstLineNo, lastLineNo));
                cardType = null;
            }
            cardText = "";
            firstLineNo = i + 1;
            continue;
        }

        // 更新卡片文本
        if (cardText.length > 0) {
            cardText += "\n";
        }
        cardText += currentLine.trimEnd();

        // 检测单行卡片
        for (const { separator, type } of inlineSeparators) {
            if (hasInlineMarker(currentLine, separator)) {
                cardType = type;
                break;
            }
        }

        if (cardType == CardType.SingleLineBasic || cardType == CardType.SingleLineReversed) {
            cardText = currentLine;
            firstLineNo = i;

            // 检查下一行是否有调度信息
            if (i + 1 < lines.length && lines[i + 1].startsWith("<!--SR:")) {
                cardText += "\n" + lines[i + 1];
                i++;
            }

            lastLineNo = i;
            cards.push(new ParsedQuestionInfo(cardType, cardText, firstLineNo, lastLineNo));
            cardType = null;
            cardText = "";
        } else if (currentTrimmed === options.multilineCardSeparator) {
            // 多行基础卡片
            if (cardText.length > 1) {
                cardType = CardType.MultiLineBasic;
            }
        } else if (currentTrimmed === options.multilineReversedCardSeparator) {
            // 多行反转卡片
            if (cardText.length > 1) {
                cardType = CardType.MultiLineReversed;
            }
        } else if (currentLine.startsWith("```") || currentLine.startsWith("~~~")) {
            // 处理代码块，避免代码块内的分隔符被误识别
            const codeBlockClose = currentLine.match(/`+|~+/)[0];
            while (i + 1 < lines.length && !lines[i + 1].startsWith(codeBlockClose)) {
                i++;
                cardText += "\n" + lines[i];
            }
            cardText += "\n" + codeBlockClose;
            i++;
        } else if (cardType === null && clozecrafter.isClozeNote(currentLine)) {
            // 填空卡片
            cardType = CardType.Cloze;
        }
    }

    // 处理最后一张卡片
    if (cardType && cardText) {
        lastLineNo = lines.length - 1;
        cards.push(new ParsedQuestionInfo(cardType, cardText.trimEnd(), firstLineNo, lastLineNo));
    }

    return cards;
}
```

### 2.4 分隔符检测机制

```typescript
// src/parser.ts - hasInlineMarker函数
function hasInlineMarker(text: string, marker: string): boolean {
    // 没有提供分隔符
    if (marker.length == 0) return false;

    // 检查分隔符是否在文本中
    const markerIdx = text.indexOf(marker);
    if (markerIdx === -1) return false;

    // 检查是否在内联代码块中
    return !markerInsideCodeBlock(text, marker, markerIdx);
}

function markerInsideCodeBlock(text: string, marker: string, markerIndex: number): boolean {
    let goingBack = markerIndex - 1, goingForward = markerIndex + marker.length;
    let backTicksBefore = 0, backTicksAfter = 0;

    // 统计分隔符前后的反引号数量
    while (goingBack >= 0) {
        if (text[goingBack] === "`") backTicksBefore++;
        goingBack--;
    }

    while (goingForward < text.length) {
        if (text[goingForward] === "`") backTicksAfter++;
        goingForward++;
    }

    // 如果前后都有奇数个反引号，说明分隔符在内联代码块中
    return backTicksBefore % 2 === 1 && backTicksAfter % 2 === 1;
}
```

### 2.5 卡片类型转换

```typescript
// src/question-type.ts - CardFrontBackUtil.expand
static expand(questionType: CardType, questionText: string, settings: SRSettings): CardFrontBack[] {
    const handler: IQuestionTypeHandler = QuestionTypeFactory.create(questionType);
    return handler.expand(questionText, settings);
}
```

**各类型的具体转换逻辑：**

1. **单行基础卡片**：
```typescript
// src/question-type.ts - QuestionTypeSingleLineBasic
expand(questionText: string, settings: SRSettings): CardFrontBack[] {
    const idx: number = questionText.indexOf(settings.singleLineCardSeparator);
    const item: CardFrontBack = new CardFrontBack(
        questionText.substring(0, idx),
        questionText.substring(idx + settings.singleLineCardSeparator.length),
    );
    return [item];
}
```

2. **单行反转卡片**：
```typescript
// src/question-type.ts - QuestionTypeSingleLineReversed
expand(questionText: string, settings: SRSettings): CardFrontBack[] {
    const idx: number = questionText.indexOf(settings.singleLineReversedCardSeparator);
    const side1: string = questionText.substring(0, idx);
    const side2: string = questionText.substring(idx + settings.singleLineReversedCardSeparator.length);
    
    // 生成两张卡片：正向和反向
    return [
        new CardFrontBack(side1, side2),
        new CardFrontBack(side2, side1),
    ];
}
```

3. **填空卡片**：
```typescript
// src/question-type.ts - QuestionTypeCloze
expand(questionText: string, settings: SRSettings): CardFrontBack[] {
    const clozecrafter = new ClozeCrafter(settings.clozePatterns);
    const clozeNote = clozecrafter.createClozeNote(questionText);
    const clozeFormatter = new QuestionTypeClozeFormatter();

    const result: CardFrontBack[] = [];
    for (let i = 0; i < clozeNote.numCards; i++) {
        const front = clozeNote.getCardFront(i, clozeFormatter);
        const back = clozeNote.getCardBack(i, clozeFormatter);
        result.push(new CardFrontBack(front, back));
    }
    return result;
}
```

### 2.6 调度信息管理

每张卡片的调度信息以HTML注释形式存储：

```html
<!-- SR:!2023-09-02,4,270!2023-09-02,5,270 -->
```

**格式说明：**
- `!` 表示一个卡片的调度信息开始
- `2023-09-02` 下次复习日期
- `4` 复习间隔（天）
- `270` 难度系数（ease factor，基数250）
- 多张卡片的调度信息用 `!` 分隔

## 3. 复习状态判断机制

### 3.1 今天需要复习的判断

```typescript
// src/algorithms/base/rep-item-schedule-info.ts
isDue(): boolean {
    return this.dueDate && this.dueDate.isSameOrBefore(globalDateProvider.today);
}
```

### 3.2 复习队列构建

```typescript
// src/deck.ts - DeckTreeFilter.filterForRemainingCards
static filterForRemainingCards(
    questionPostponementList: QuestionPostponementList,
    reviewableDeckTree: Deck,
    reviewMode: FlashcardReviewMode,
): Deck {
    const result: Deck = reviewableDeckTree.clone();
    result.filterCards((card: Card) => {
        if (questionPostponementList.includes(card.question)) {
            return false;
        }

        if (reviewMode === FlashcardReviewMode.Review) {
            return !card.hasSchedule || card.isDue();
        }

        return true;
    });
    return result;
}
```

## 4. 间隔重复算法实现

### 4.1 OSR 算法核心

```typescript
// src/algorithms/osr/note-scheduling.ts
export function osrSchedule(
    response: ReviewResponse,
    originalInterval: number,
    ease: number,
    delayedBeforeReview: number,
    settings: SRSettings,
    dueDateHistogram?: DueDateHistogram,
): Record<string, number> {
    const delayedBeforeReviewDays = Math.max(0, Math.floor(delayedBeforeReview / TICKS_PER_DAY));
    let interval: number = originalInterval;

    if (response === ReviewResponse.Easy) {
        ease += 20;
        interval = ((interval + delayedBeforeReviewDays) * ease) / 100;
        interval *= settings.easyBonus;
    } else if (response === ReviewResponse.Good) {
        interval = ((interval + delayedBeforeReviewDays / 2) * ease) / 100;
    } else if (response === ReviewResponse.Hard) {
        ease = Math.max(130, ease - 20);
        interval = Math.max(
            1,
            (interval + delayedBeforeReviewDays / 4) * settings.lapsesIntervalChange,
        );
    }

    // 负载均衡：避免复习日期过于集中
    if (settings.loadBalance && dueDateHistogram !== undefined) {
        interval = Math.round(interval);
        if (interval > 7) {
            let fuzz: number;
            if (interval <= 21) fuzz = 1;
            else if (interval <= 180) fuzz = Math.min(3, Math.floor(interval * 0.05));
            else fuzz = Math.min(7, Math.floor(interval * 0.025));

            interval = dueDateHistogram.findLeastUsedIntervalOverRange(interval, fuzz);
        }
    }

    interval = Math.min(interval, settings.maximumInterval);
    interval = Math.round(interval * 10) / 10;

    return { interval, ease };
}
```

### 4.2 新卡片调度

```typescript
// src/algorithms/osr/srs-algorithm-osr.ts
cardGetNewSchedule(
    response: ReviewResponse,
    notePath: string,
    dueDateFlashcardHistogram: DueDateHistogram,
): RepItemScheduleInfo {
    let initialEase: number = this.settings.baseEase;
    if (this.noteEaseList.hasEaseForPath(notePath)) {
        initialEase = Math.round(this.noteEaseList.getEaseByPath(notePath));
    }
    const delayBeforeReview = 0;

    const schedObj: Record<string, number> = osrSchedule(
        response,
        SrsAlgorithmOsr.initialInterval,
        initialEase,
        delayBeforeReview,
        this.settings,
        dueDateFlashcardHistogram,
    );

    const interval = schedObj.interval;
    const ease = schedObj.ease;
    const dueDate = globalDateProvider.today.add(interval, "d");
    return new RepItemScheduleInfoOsr(dueDate, interval, ease, delayBeforeReview);
}
```

## 5. 笔记复习系统

### 5.1 笔记复习队列

```typescript
// src/note-review-queue.ts
addNoteToQueue(
    noteFile: ISRFile,
    noteSchedule: RepItemScheduleInfo,
    tags: string[],
): void {
    for (const tag of tags) {
        const deckName = this.determineDeckName(noteFile.path, tag);
        
        if (!this.reviewDecks.has(deckName)) {
            this.reviewDecks.set(deckName, new NoteReviewDeck(deckName));
        }
        
        const deck = this.reviewDecks.get(deckName);
        
        if (noteSchedule) {
            deck.scheduledNotes.push(new SchedNote(noteFile, noteSchedule.dueDateAsUnix));
        } else {
            deck.newNotes.push(noteFile);
        }
    }
}
```

### 5.2 笔记复习算法

笔记复习考虑了笔记间的链接关系：

```typescript
// src/algorithms/osr/srs-algorithm-osr.ts
noteCalcNewSchedule(
    notePath: string,
    osrNoteGraph: OsrNoteGraph,
    response: ReviewResponse,
    dueDateNoteHistogram: DueDateHistogram,
): RepItemScheduleInfo {
    const noteLinkStat: NoteLinkStat = osrNoteGraph.calcNoteLinkStat(
        notePath,
        this.noteEaseList,
    );

    const linkContribution: number =
        this.settings.maxLinkFactor *
        Math.min(1.0, Math.log(noteLinkStat.totalLinkCount + 0.5) / Math.log(64));
    let ease: number =
        (1.0 - linkContribution) * this.settings.baseEase +
        (noteLinkStat.totalLinkCount > 0
            ? (linkContribution * noteLinkStat.linkTotal) / noteLinkStat.linkPGTotal
            : linkContribution * this.settings.baseEase);

    if (this.noteEaseList.hasEaseForPath(notePath)) {
        ease = (ease + this.noteEaseList.getEaseByPath(notePath)) / 2;
    }

    ease = Math.round(ease);
    const temp: RepItemScheduleInfoOsr = new RepItemScheduleInfoOsr(null, SrsAlgorithmOsr.initialInterval, ease);

    const result: RepItemScheduleInfoOsr = this.calcSchedule(
        temp,
        response,
        dueDateNoteHistogram,
    );

    result.dueDate = moment(globalDateProvider.today.add(result.interval, "d"));
    return result;
}
```

## 6. 数据持久化机制

### 6.1 闪卡数据存储

```typescript
// src/data-stores/notes/notes.ts
async questionWriteSchedule(question: Question): Promise<void> {
    let fileText: string = await question.note.file.read();
    
    for (let i = 0; i < question.cards.length; i++) {
        fileText = this.writeCardScheduleToFileText(
            fileText,
            question,
            i,
            question.cards[i].scheduleInfo,
        );
    }
    
    await question.note.file.write(fileText);
}
```

### 6.2 笔记数据存储

```typescript
// src/data-store-algorithm/data-store-in-note-algorithm-osr.ts
async noteSetSchedule(note: ISRFile, repItemScheduleInfo: RepItemScheduleInfo): Promise<void> {
    const frontmatter: Map<string, string> = await note.getFrontmatter();
    frontmatter.set("sr-due", repItemScheduleInfo.formatDueDate());
    frontmatter.set("sr-interval", repItemScheduleInfo.interval.toString());
    frontmatter.set("sr-ease", repItemScheduleInfo.latestEase.toString());

    await this.writeFrontmatterToNote(note, frontmatter);
}
```

## 7. 用户界面交互

### 7.1 复习响应处理

```typescript
// src/flashcard-review-sequencer.ts
async processReview(response: ReviewResponse): Promise<void> {
    switch (this.reviewMode) {
        case FlashcardReviewMode.Review:
            await this.processReviewReviewMode(response);
            break;

        case FlashcardReviewMode.Cram:
            await this.processReviewCramMode(response);
            break;
    }
}

async processReviewReviewMode(response: ReviewResponse): Promise<void> {
    if (response != ReviewResponse.Reset || this.currentCard.hasSchedule) {
        const oldSchedule = this.currentCard.scheduleInfo;

        this.currentCard.scheduleInfo = this.determineCardSchedule(response, this.currentCard);

        await DataStore.getInstance().questionWriteSchedule(this.currentQuestion);

        if (oldSchedule) {
            const today: number = globalDateProvider.today.valueOf();
            const nDays: number = Math.ceil(
                (oldSchedule.dueDateAsUnix - today) / TICKS_PER_DAY,
            );

            this.dueDateFlashcardHistogram.decrement(nDays);
        }
        this.dueDateFlashcardHistogram.increment(this.currentCard.scheduleInfo.interval);
    }

    if (response == ReviewResponse.Reset) {
        this.cardSequencer.moveCurrentCardToEndOfList();
        this.cardSequencer.nextCard();
    } else {
        if (this.settings.burySiblingCards) {
            await this.burySiblingCards();
            this.cardSequencer.deleteCurrentQuestionFromAllDecks();
        } else {
            this.deleteCurrentCard();
        }
    }
}
```

## 8. 性能优化策略

### 8.1 缓存机制

```typescript
// src/file.ts - SrTFile.getAllTagsFromCache
getAllTagsFromCache(): string[] {
    const tags: string[] = [];
    const cache = this.metadataCache.getFileCache(this.file);
    
    if (cache?.tags) {
        for (const tag of cache.tags) {
            tags.push(tag.tag);
        }
    }
    
    if (cache?.frontmatter?.tags) {
        const frontmatterTags = parseObsidianFrontmatterTag(cache.frontmatter.tags);
        tags.push(...frontmatterTags);
    }
    
    return tags;
}
```

### 8.2 延迟加载

```typescript
// src/core.ts - processFile 中的性能优化
const topicPath: TopicPath = this.findTopicPath(noteFile);
if (topicPath.hasPath) {
    // 只有包含相关标签的文件才会被完整解析
    note = await this.loadNote(noteFile, topicPath);
    note.appendCardsToDeck(this.fullDeckTree);
}
```

### 8.3 同步锁

```typescript
// src/core.ts - OsrAppCore.loadVault
async loadVault(): Promise<void> {
    if (this._syncLock) {
        return; // 如果正在同步，直接返回
    }
    this._syncLock = true;

    try {
        // 执行同步操作
        this.loadInit();
        // ... 其他操作
    } finally {
        this._syncLock = false;
    }
}
```

## 9. 关键技术点总结

### 9.1 文档识别
- 通过文件标签识别闪卡文档和笔记复习文档
- 利用 Obsidian 的元数据缓存提高性能
- 支持文件夹路径和标签两种分类方式

### 9.2 调度算法
- 基于 SM-2 算法的改进版本（OSR）
- 考虑笔记间链接关系影响难度
- 负载均衡避免复习日期集中
- 支持模糊间隔增加随机性

### 9.3 数据存储
- 闪卡调度信息存储在 HTML 注释中
- 笔记调度信息存储在 frontmatter 中
- 直接修改 Markdown 文件，保持数据透明性

### 9.4 用户体验
- 支持多种闪卡格式
- 提供丰富的复习统计信息
- 支持键盘快捷键操作
- 可自定义复习顺序和显示选项

这个插件通过精心设计的架构，实现了一个功能完整、性能优良的间隔重复学习系统，充分利用了 Obsidian 的平台特性。 