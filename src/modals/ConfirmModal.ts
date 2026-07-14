import { App, Modal } from "obsidian";

/** Generic yes/no confirmation, used ahead of bulk Reject all/Keep all when
 *  the user has "Confirm before bulk actions" enabled in settings (off by
 *  default -- see settings.ts). Resolves `false` for any dismissal path
 *  (Cancel, Escape, clicking outside), not just an explicit Cancel click. */
export class ConfirmModal extends Modal {
  private resolvePromise: ((value: boolean) => void) | null = null;

  private constructor(app: App, private title: string, private message: string, private confirmText: string) {
    super(app);
  }

  static confirm(app: App, title: string, message: string, confirmText = "Confirm"): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(app, title, message, confirmText);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.resolve(false));
    buttonRow.createEl("button", { text: this.confirmText, cls: "mod-cta" }).addEventListener("click", () =>
      this.resolve(true)
    );
  }

  onClose(): void {
    this.contentEl.empty();
    // Covers Escape/click-outside too -- an unresolved promise would hang
    // the caller forever otherwise.
    this.resolve(false);
  }

  private resolve(value: boolean): void {
    // Guards against re-entering: an explicit button click calls resolve()
    // then close(), and close() triggers onClose(), which also calls
    // resolve() -- without this guard that second call would recurse into
    // close() again.
    if (!this.resolvePromise) return;
    const resolvePromise = this.resolvePromise;
    this.resolvePromise = null;
    resolvePromise(value);
    this.close();
  }
}
