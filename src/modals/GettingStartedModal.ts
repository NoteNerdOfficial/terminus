import { App, Component, MarkdownRenderer, Modal } from "obsidian";
import { buildGettingStartedMarkdown, buildWelcomeMarkdown } from "../onboarding/gettingStarted";

/**
 * Onboarding panel, in two lengths.
 *
 * Nothing is written to the vault to show this. Creating a note on install
 * puts a file in someone's vault they never asked for (and that syncs, and
 * that they have to delete); a modal makes the same content available
 * without touching anything. The full guide stays reachable from the
 * command palette afterwards, so dismissing this doesn't lose it.
 */
export class GettingStartedModal extends Modal {
  /** MarkdownRenderer.render() attaches child components (callouts,
   *  embeds, internal-link hover) to a parent whose lifecycle it inherits.
   *  Modal isn't a Component, so this owns them and is unloaded on close --
   *  without it those children would leak past the modal. */
  private readonly renderHost = new Component();

  private constructor(app: App, private readonly full: boolean) {
    super(app);
  }

  /** Short version, shown once on first load. */
  static openWelcome(app: App): void {
    new GettingStartedModal(app, false).open();
  }

  /** Full reference, from the command palette. */
  static openGuide(app: App): void {
    new GettingStartedModal(app, true).open();
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("terminus-getting-started-modal");
    this.renderHost.load();

    contentEl.createEl("h2", { text: this.full ? "Terminus — getting started" : "Welcome to Terminus" });

    const body = contentEl.createDiv({ cls: "terminus-getting-started-body" });
    const markdown = this.full ? buildGettingStartedMarkdown() : buildWelcomeMarkdown();
    // Empty sourcePath: the content is bundled, not a vault note, so there
    // are no relative links for Obsidian to resolve against a file.
    void MarkdownRenderer.render(this.app, markdown, body, "", this.renderHost);

    const actions = contentEl.createDiv({ cls: "terminus-getting-started-actions" });
    if (!this.full) {
      actions.createEl("button", { text: "Full guide" }).addEventListener("click", () => {
        this.close();
        GettingStartedModal.openGuide(this.app);
      });
    }
    actions
      .createEl("button", { text: this.full ? "Done" : "Got it", cls: "mod-cta" })
      .addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.renderHost.unload();
    this.contentEl.empty();
  }
}
