import { App, Modal } from "obsidian";

/**
 * One-time invite to try the Multi-agent experience. Shown either the first
 * time pending changes come from two terminals at once (see main.ts) -- the
 * moment its per-session inbox actually helps -- or once, shortly after
 * loading the version that introduced it ("announcement"). Resolves true for
 * "Try multi-agent" and false for every other way out (Not now, Escape,
 * clicking outside), so a dismissal is never mistaken for a yes.
 */
export type InviteReason = "two-terminals" | "announcement";

export class MultiAgentInviteModal extends Modal {
  private resolvePromise: ((accepted: boolean) => void) | null = null;

  private constructor(
    app: App,
    private reason: InviteReason
  ) {
    super(app);
  }

  static ask(app: App, reason: InviteReason = "two-terminals"): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new MultiAgentInviteModal(app, reason);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl } = this;
    const announcement = this.reason === "announcement";
    contentEl.createEl("h3", { text: announcement ? "New in Terminus: Multi-agent" : "Running Claude in more than one terminal?" });
    contentEl.createEl("p", {
      text: `${announcement ? "Run several Claude sessions side by side. " : ""}Try the Multi-agent experience: an Agent inbox with a card per Claude session showing what it's doing, what it changed, and when it needs your attention, plus groups to keep related terminals together.`,
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
