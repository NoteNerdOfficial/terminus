import { App, Modal } from "obsidian";

/** Prompts for a custom terminal name, prefilled with the current one.
 *  Submitting empty resolves `null` -- the caller treats that as "reset to
 *  the default numbered name," so there's no separate reset control. */
export class RenameTerminalModal extends Modal {
  private resolvePromise: ((value: string | null) => void) | null = null;
  private inputEl: HTMLInputElement | null = null;

  private constructor(app: App, private currentName: string) {
    super(app);
  }

  static prompt(app: App, currentName: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new RenameTerminalModal(app, currentName);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Rename terminal" });

    this.inputEl = contentEl.createEl("input", { type: "text", value: this.currentName });
    this.inputEl.addClass("terminus-rename-modal-input");
    this.inputEl.select();
    this.inputEl.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        this.submit();
      }
    });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.resolve(null));
    buttonRow.createEl("button", { text: "Rename", cls: "mod-cta" }).addEventListener("click", () => this.submit());
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(null);
  }

  private submit(): void {
    const value = this.inputEl?.value.trim() ?? "";
    this.resolve(value || null);
  }

  private resolve(value: string | null): void {
    // Guards against re-entering: an explicit action calls resolve() then
    // close(), and close() triggers onClose(), which also calls resolve()
    // -- without this guard that second call would recurse into close()
    // again (same pattern as ConfirmModal).
    if (!this.resolvePromise) return;
    const resolvePromise = this.resolvePromise;
    this.resolvePromise = null;
    resolvePromise(value);
    this.close();
  }
}
