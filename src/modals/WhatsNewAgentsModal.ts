import { App, Modal } from "obsidian";

/**
 * "What's new" for the release that added notifications and agent control,
 * shown once to an install that had Terminus before it (see main.ts's
 * announceAgentFeatures). Both features are things nobody would find on
 * their own: notifications only happen while you're looking elsewhere, and
 * agent control ships off.
 *
 * Resolves "settings" for "Open settings"; every other way out is "close".
 */
export type WhatsNewAgentsChoice = "close" | "settings";

export class WhatsNewAgentsModal extends Modal {
  private resolvePromise: ((choice: WhatsNewAgentsChoice) => void) | null = null;

  private constructor(
    app: App,
    private readonly multiAgent: boolean
  ) {
    super(app);
  }

  /** `multiAgent`: agent control works only there, so Classic is told how
   *  to get it rather than shown a setting it can't use. */
  static ask(app: App, multiAgent: boolean): Promise<WhatsNewAgentsChoice> {
    return new Promise((resolve) => {
      const modal = new WhatsNewAgentsModal(app, multiAgent);
      modal.resolvePromise = resolve;
      modal.open();
    });
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("terminus-whats-new-modal");

    contentEl.createEl("h3", { text: "What's new in Terminus" });
    contentEl.createEl("p", {
      cls: "terminus-whats-new-lead",
      text: "Terminus now tells you when Claude needs you, and Claude can work with Terminus itself.",
    });

    const list = contentEl.createEl("ul", { cls: "terminus-whats-new-list" });
    const point = (title: string, text: string) => {
      const item = list.createEl("li");
      item.createEl("strong", { text: title });
      item.appendText(` ${text}`);
    };
    point(
      "Notifications.",
      "When a session asks for permission or finishes while you're looking at something else, a notice says so. Click it to jump to that terminal. On by default, inside Obsidian; switch to system notifications or add a ding in settings."
    );
    point(
      "Agent control.",
      "Let Claude open terminals beside it for a dev server or a long test run, read their output, and tell you when something needs you."
    );
    point(
      "Agents working together.",
      "Claude can message other sessions in its group, wait for them, and hand a task to a new session whose result comes back on its own."
    );

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.multiAgent
        ? "Agent control is off until you turn it on under Settings → Terminus → Agent control. It only reaches terminals in the agent's own group. This won't be shown again."
        : "Agent control needs the Multi-agent experience (Settings → Terminus → Experience) and is off until you turn it on. This won't be shown again.",
    });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Open settings" }).addEventListener("click", () => this.finish("settings"));
    const gotIt = buttonRow.createEl("button", { text: "Got it", cls: "mod-cta" });
    gotIt.addEventListener("click", () => this.finish("close"));
    window.setTimeout(() => gotIt.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish("close");
  }

  private finish(choice: WhatsNewAgentsChoice): void {
    const resolve = this.resolvePromise;
    if (!resolve) return;
    this.resolvePromise = null;
    resolve(choice);
    this.close();
  }
}
