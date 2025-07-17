import { App, Modal } from "obsidian";
import { GradeType } from "ts-fsrs";

export class FourButtonModal extends Modal {
    private callback: (choice: GradeType) => void;

    constructor(app: App, callback: (choice: GradeType) => void) {
        super(app);
        this.callback = callback;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "选择记忆难度：" });

        const options = ["Again", "Hard", "Good", "Easy"];
        options.forEach((label) => {
            const btn = contentEl.createEl("button", { text: label });
            btn.style.marginRight = "10px";
            btn.addEventListener("click", () => {
                this.callback(label as GradeType);
                this.close(); // 关闭弹窗
            });
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
