import { App, Modal, Notice, Setting } from "obsidian";

export class TagInputModal extends Modal {
    onSubmit: (tag: string) => void;

    constructor(app: App, onSubmit: (tag: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "请输入要添加的Tag（需要加 #）" });

        let tagValue = "";

        new Setting(contentEl).setName("Tag").addText((text) =>
            text.onChange((value) => {
                tagValue = value;
            }),
        );

        new Setting(contentEl).addButton((btn) =>
            btn
                .setButtonText("确认")
                .setCta()
                .onClick(() => {
                    if (!tagValue.trim()) {
                        new Notice("Tag不能为空");
                        return;
                    }
                    this.close();
                    this.onSubmit(tagValue.trim());
                }),
        );
    }

    onClose() {
        this.contentEl.empty();
    }
}
