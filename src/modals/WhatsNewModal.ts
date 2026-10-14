import { App, Modal } from "obsidian";
import { WHATS_NEW_VIDEO } from "../onboarding/whatsNewMedia";

/**
 * "What's new" popup, shown once to an existing install that was moved to
 * the Multi-agent experience when it became the default. It says what the
 * update brings, shows it in a short clip, and offers the way back.
 *
 * Resolves "classic" only for "Switch to Classic" and "guide" only for
 * "Read the guide"; every other way out (Got it, Escape, clicking outside)
 * is "keep", so a dismissal never undoes the move.
 */
export type WhatsNewChoice = "keep" | "classic" | "guide";

export class WhatsNewModal extends Modal {
  private resolvePromise: ((choice: WhatsNewChoice) => void) | null = null;

  private constructor(app: App) {
    super(app);
  }

  static ask(app: App): Promise<WhatsNewChoice> {
    return new Promise((resolve) => {
      const modal = new WhatsNewModal(app);
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
      text: "Multi-agent is now the default: run several Claude sessions side by side and see all of them in one place.",
    });

    const video = contentEl.createEl("video", {
      cls: "terminus-whats-new-video",
      attr: { src: WHATS_NEW_VIDEO, autoplay: "", loop: "", muted: "", playsinline: "" },
    });
    // The attribute alone doesn't mute it in every Electron build, and a
    // sound from a popup is never wanted.
    video.muted = true;
    video.addEventListener("error", () => video.remove());

    const list = contentEl.createEl("ul", { cls: "terminus-whats-new-list" });
    const point = (title: string, text: string) => {
      const item = list.createEl("li");
      item.createEl("strong", { text: title });
      item.appendText(` ${text}`);
    };
    point("Agent inbox.", "A card per Claude session: what it's doing, what it changed, and when it needs you.");
    point("Groups.", "Keep the terminals for one piece of work together, and settle or snooze them when you're done.");
    point("Steer or queue.", "Send a message into a running turn, or queue messages to go out one turn at a time.");

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Prefer the single Pending Changes panel? Switch back to Classic here, or any time under Settings → Terminus → Experience. This won't be shown again.",
    });

    const buttonRow = contentEl.createDiv({ cls: "terminus-confirm-modal-actions" });
    buttonRow.createEl("button", { text: "Switch to Classic" }).addEventListener("click", () => this.finish("classic"));
    buttonRow.createEl("button", { text: "Read the guide" }).addEventListener("click", () => this.finish("guide"));
    const gotIt = buttonRow.createEl("button", { text: "Got it", cls: "mod-cta" });
    gotIt.addEventListener("click", () => this.finish("keep"));
    // Obsidian focuses a modal's first button, which here would make a
    // reflexive Enter switch someone back to Classic.
    window.setTimeout(() => gotIt.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish("keep");
  }

  private finish(choice: WhatsNewChoice): void {
    const resolve = this.resolvePromise;
    if (!resolve) return;
    this.resolvePromise = null;
    resolve(choice);
    this.close();
  }
}
