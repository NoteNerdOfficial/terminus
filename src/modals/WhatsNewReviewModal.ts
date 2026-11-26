import { App, Modal } from "obsidian";
import reviewShot from "../assets/whats-new-review.jpg";

/**
 * "What's new" for the release that added review mode to the Terminus
 * browser, shown once to an install that had Terminus before it (see
 * main.ts's announceReviewFeature). The screenshot is bundled into main.js,
 * so showing it fetches nothing.
 *
 * Resolves "open" for "Open a page"; every other way out is "close".
 */
export type WhatsNewReviewChoice = "close" | "open";

export class WhatsNewReviewModal extends Modal {
  private resolvePromise: ((choice: WhatsNewReviewChoice) => void) | null = null;

  private constructor(
    app: App,
    private readonly agentsCanAnswer: boolean
  ) {
    super(app);
  }

  /** `agentsCanAnswer`: whether agents may use the browser here, so the
   *  note under the list says what's needed only when something is. */
  static ask(app: App, agentsCanAnswer: boolean): Promise<WhatsNewReviewChoice> {
    return new Promise((resolve) => {
      const modal = new WhatsNewReviewModal(app, agentsCanAnswer);
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
      text: "Review pages and notes with Claude, right in Obsidian.",
    });
    contentEl.createEl("img", {
      cls: "terminus-whats-new-demo",
      attr: {
        src: reviewShot,
        alt: "Review mode in the Terminus browser: numbered pins on a page, a comment box with Change, Question and Keep, and a list of comments the agent has answered",
      },
    });

    const list = contentEl.createEl("ul", { cls: "terminus-whats-new-list" });
    const point = (title: string, text: string) => {
      const item = list.createEl("li");
      item.createEl("strong", { text: title });
      item.appendText(` ${text}`);
    };
    point(
      "Comment on the page.",
      "Turn on Review, click anything and leave a Change, Question or Keep comment. Its pin stays where you clicked."
    );
    point(
      "Claude answers each one.",
      "Send your comments to a Claude session, or start a new one. It gets the element, a screenshot and the file behind the page, then answers beside each pin. You accept the fix or follow up."
    );
    point(
      "Review notes too.",
      "Select text in a note, right-click and choose Review with Terminus. Comments queue on the session's card in the Agent inbox, where you can reorder and edit them before sending them together."
    );
    point(
      "Keep what's right.",
      "Mark something Keep, on a page or in a note, and Terminus tells you if a later change touches it."
    );
    point(
      "Open pages yourself.",
      "Use “Open a local page in the browser” for a dev server, or open a site another plugin offers, such as a Vault Publisher preview."
    );

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.agentsCanAnswer
        ? "This won't be shown again."
        : "For Claude to answer in the browser, turn on Settings → Terminus → Agent control → Let agents use a browser. Without it, comments still go to Claude as a message. This won't be shown again.",
    });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Open a page" }).addEventListener("click", () => this.finish("open"));
    const gotIt = buttonRow.createEl("button", { text: "Got it", cls: "mod-cta" });
    gotIt.addEventListener("click", () => this.finish("close"));
    window.setTimeout(() => gotIt.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish("close");
  }

  private finish(choice: WhatsNewReviewChoice): void {
    const resolve = this.resolvePromise;
    if (!resolve) return;
    this.resolvePromise = null;
    resolve(choice);
    this.close();
  }
}
