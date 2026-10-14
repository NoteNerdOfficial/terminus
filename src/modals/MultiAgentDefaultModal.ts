import { App, Modal } from "obsidian";

/**
 * One-time notice, shown to an existing install that was moved to the
 * Multi-agent experience when it became the default. Resolves "classic" only
 * for "Switch to Classic"; every other way out (Got it, Escape, clicking
 * outside) keeps Multi-agent, so a dismissal never undoes the move.
 */
export class MultiAgentDefaultModal extends Modal {
  private resolvePromise: ((choice: "keep" | "classic") => void) | null = null;

  private constructor(app: App) {
    super(app);
  }

  static ask(app: App): Promise<"keep" | "classic"> {
    return new Promise((resolve) => {
      const modal = new MultiAgentDefaultModal(app);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Terminus now opens in Multi-agent" });
    contentEl.createEl("p", {
      text: "You now get an Agent inbox with a card per Claude session showing what it's doing, what it changed and when it needs you, plus groups to keep related terminals together. Your terminals and pending changes carry over.",
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Prefer the single Pending Changes panel? Switch back to Classic here, or any time under Settings → Terminus → Experience. This won't be shown again.",
    });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Switch to Classic" }).addEventListener("click", () => this.finish("classic"));
    buttonRow.createEl("button", { text: "Got it", cls: "mod-cta" }).addEventListener("click", () => this.finish("keep"));
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish("keep");
  }

  private finish(choice: "keep" | "classic"): void {
    const resolve = this.resolvePromise;
    if (!resolve) return;
    this.resolvePromise = null;
    resolve(choice);
    this.close();
  }
}
