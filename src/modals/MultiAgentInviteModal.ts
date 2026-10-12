import { App, Modal } from "obsidian";

/**
 * One-time invite to try the Multi-agent experience, shown the first time
 * pending changes come from two terminals at once (see main.ts) -- the
 * moment its per-session inbox actually helps. Resolves true for "Try
 * multi-agent" and false for every other way out (Not now, Escape, clicking
 * outside), so a dismissal is never mistaken for a yes.
 */
export class MultiAgentInviteModal extends Modal {
  private resolvePromise: ((accepted: boolean) => void) | null = null;

  static ask(app: App): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new MultiAgentInviteModal(app);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Running Claude in more than one terminal?" });
    contentEl.createEl("p", {
      text: "Try the Multi-agent experience: an Agent inbox with a card per Claude session showing what it's doing, what it changed, and when it needs you, plus groups to keep related terminals together.",
    });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "You can switch back any time under Settings → Terminus → Experience. This won't be shown again.",
    });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Not now" }).addEventListener("click", () => this.finish(false));
    buttonRow.createEl("button", { text: "Try multi-agent", cls: "mod-cta" }).addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(false);
  }

  private finish(accepted: boolean): void {
    const resolve = this.resolvePromise;
    if (!resolve) return;
    this.resolvePromise = null;
    resolve(accepted);
    this.close();
  }
}
