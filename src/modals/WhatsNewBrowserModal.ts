import { App, Modal } from "obsidian";
import browserDemo from "../assets/whats-new-browser.gif";

/**
 * "What's new" for the release that added the agent browser, shown once to
 * an install that had Terminus before it (see main.ts's
 * announceBrowserFeature). The browser ships off and lives under agent
 * control, so nobody would find it on their own.
 *
 * The animation is bundled into main.js, so showing it fetches nothing.
 * Resolves "settings" for "Open settings"; every other way out is "close".
 */
export type WhatsNewBrowserChoice = "close" | "settings";

export class WhatsNewBrowserModal extends Modal {
  private resolvePromise: ((choice: WhatsNewBrowserChoice) => void) | null = null;

  private constructor(
    app: App,
    private readonly multiAgent: boolean
  ) {
    super(app);
  }

  /** `multiAgent`: the browser works only there, so Classic is told how to
   *  get it rather than shown a setting it can't use. */
  static ask(app: App, multiAgent: boolean): Promise<WhatsNewBrowserChoice> {
    return new Promise((resolve) => {
      const modal = new WhatsNewBrowserModal(app, multiAgent);
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
      text: "Agents can now use a browser to check the UI they build.",
    });
    contentEl.createEl("img", {
      cls: "terminus-whats-new-demo",
      attr: {
        src: browserDemo,
        alt: "An agent filling in a sign-up prototype, its pixel companion walking to each field, cheering when the thanks message appears and putting on sunglasses for a screenshot",
      },
    });

    const list = contentEl.createEl("ul", { cls: "terminus-whats-new-list" });
    const point = (title: string, text: string) => {
      const item = list.createEl("li");
      item.createEl("strong", { text: title });
      item.appendText(` ${text}`);
    };
    point(
      "A browser beside the agent.",
      "It opens a prototype from your vault, or the dev server it just started, then reads the page, clicks, types, waits for results and takes screenshots."
    );
    point(
      "See what it does.",
      "Its pixel companion, in the group's colour, walks to everything the agent touches, says what it's doing and reacts as it goes. Your keyboard focus stays where you are."
    );
    point(
      "Your computer only.",
      "It opens local pages, never outside websites, since a page's text goes straight to an agent that runs with your shell permissions."
    );

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.multiAgent
        ? "Off until you turn it on under Settings → Terminus → Agent control → Let agents use a browser. This won't be shown again."
        : "The agent browser needs the Multi-agent experience (Settings → Terminus → Experience) and agent control, and is off until you turn it on. This won't be shown again.",
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

  private finish(choice: WhatsNewBrowserChoice): void {
    const resolve = this.resolvePromise;
    if (!resolve) return;
    this.resolvePromise = null;
    resolve(choice);
    this.close();
  }
}
