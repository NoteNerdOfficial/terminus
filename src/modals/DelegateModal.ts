import { App, Modal } from "obsidian";

/**
 * "Send to a new terminal": a prompt box. Opening the terminal starts a new
 * Claude session beside the sender with this text typed in; nothing is
 * submitted, so the user reads it and presses Enter there.
 */
export class DelegateModal extends Modal {
  private resolvePromise: ((value: string | null) => void) | null = null;
  private textEl: HTMLTextAreaElement | null = null;

  private constructor(
    app: App,
    private fromName: string,
    private groupName: string | null
  ) {
    super(app);
  }

  static prompt(app: App, fromName: string, groupName: string | null): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new DelegateModal(app, fromName, groupName);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Send to a new terminal" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `A new Claude session opens${this.groupName ? ` in ${this.groupName}` : ""}, beside ${this.fromName}, with this typed in. Nothing is sent until you press Enter there, and its result shows on ${this.fromName}'s card.`,
    });
    this.textEl = contentEl.createEl("textarea", { cls: "terminus-delegate-input", attr: { rows: "6", placeholder: "What should it do?" } });
    this.textEl.addEventListener("keydown", (evt) => {
      // ⌘/Ctrl+Enter submits; plain Enter is a newline in a prompt.
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => this.textEl?.focus(), 0);

    const buttons = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.resolve(null));
    buttons.createEl("button", { text: "Open terminal", cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }

  private submit(): void {
    const text = this.textEl?.value.trim() ?? "";
    this.resolve(text || null);
  }

  private resolve(value: string | null): void {
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    this.close();
    resolve?.(value);
  }

  onClose(): void {
    this.contentEl.empty();
    // Closed by Escape or the ×: nothing to open.
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    resolve?.(null);
  }
}
