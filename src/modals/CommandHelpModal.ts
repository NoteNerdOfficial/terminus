import { App, Modal, Setting } from "obsidian";
import { explainCommandOutput, FixSuggestion, FixSuggestionResult, suggestFixCommand } from "../claude/headlessAssist";
import { errorMessage } from "../util/errors";

export class CommandHelpModal extends Modal {
  private shownCommands: string[] = [];
  private explainResultEl!: HTMLElement;
  private suggestResultEl!: HTMLElement;

  constructor(
    app: App,
    private claudeBin: string,
    private cwd: string,
    private exitCode: number,
    private transcript: string,
    private onApplyFix: (command: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("terminus-command-help-modal");
    contentEl.createEl("h3", { text: `Command failed (exit code ${this.exitCode})` });
    contentEl.createEl("pre", { cls: "terminus-diff-body", text: this.transcript });

    // Explain's own fixed slot, ABOVE the action buttons. It stays exactly
    // where it is even if the user goes on to use Suggest a fix -- the two
    // are independent, neither one clears the other.
    this.explainResultEl = contentEl.createDiv({ cls: "terminus-command-help-result" });

    const actions = contentEl.createDiv({ cls: "terminus-command-help-actions" });
    new Setting(actions)
      .addButton((btn) =>
        btn.setButtonText("Explain this").onClick(() => this.runExplain(btn.buttonEl))
      )
      .addButton((btn) =>
        btn
          .setButtonText("Suggest a fix")
          .setCta()
          .onClick(() => this.runSuggestFix(btn.buttonEl))
      );

    // Suggest a fix's own fixed slot, BELOW the action buttons. Clicking
    // "Suggest a fix" again (there's no separate Refresh button; that IS
    // the refresh) replaces whatever's here with the next-best option,
    // since shownCommands keeps accumulating across clicks.
    this.suggestResultEl = contentEl.createDiv({ cls: "terminus-command-help-result" });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async runExplain(button: HTMLElement): Promise<void> {
    button.setAttribute("disabled", "true");
    this.explainResultEl.empty();
    this.explainResultEl.createEl("div", { text: "Asking Claude…", cls: "terminus-pending-empty" });
    try {
      const explanation = await explainCommandOutput(this.claudeBin, this.cwd, this.transcript);
      this.explainResultEl.empty();
      this.explainResultEl.createEl("p", { text: explanation });
    } catch (err) {
      this.explainResultEl.empty();
      this.explainResultEl.createEl("div", {
        text: `Couldn't get an explanation: ${errorMessage(err)}`,
        cls: "terminus-pending-empty",
      });
    } finally {
      button.removeAttribute("disabled");
    }
  }

  private async runSuggestFix(button: HTMLElement): Promise<void> {
    button.setAttribute("disabled", "true");
    this.suggestResultEl.empty();
    this.suggestResultEl.createEl("div", { text: "Asking Claude…", cls: "terminus-pending-empty" });
    try {
      const result = await suggestFixCommand(this.claudeBin, this.cwd, this.transcript, this.shownCommands);
      this.suggestResultEl.empty();
      this.renderResult(result);
    } catch (err) {
      this.suggestResultEl.empty();
      this.suggestResultEl.createEl("div", {
        text: `Couldn't get a suggestion: ${errorMessage(err)}`,
        cls: "terminus-pending-empty",
      });
    } finally {
      button.removeAttribute("disabled");
    }
  }

  private renderResult(result: FixSuggestionResult): void {
    if (result.type === "none") {
      this.suggestResultEl.createEl("div", {
        text: "Claude couldn't suggest a safe fix for this.",
        cls: "terminus-pending-empty",
      });
      return;
    }
    if (result.type === "unstructured") {
      // Claude answered, just not in the {command, description} shape --
      // usually because the input wasn't really a shell command (plain
      // English the shell rejected) and it responded conversationally
      // instead of picking one command. Showing that raw text beats a
      // parse-error message, since it's often still the actual answer.
      this.suggestResultEl.createEl("p", { text: result.text });
      return;
    }
    this.shownCommands.push(result.command);
    this.renderSuggestion(result);
  }

  private renderSuggestion(suggestion: FixSuggestion): void {
    const box = this.suggestResultEl.createDiv({ cls: "terminus-fix-suggestion-box" });
    box.createEl("code", { cls: "terminus-fix-suggestion-command", text: suggestion.command });
    box.createEl("div", { cls: "terminus-fix-suggestion-description", text: suggestion.description });

    const footer = this.suggestResultEl.createDiv({ cls: "terminus-fix-suggestion-footer" });
    new Setting(footer)
      .addButton((btn) =>
        // Cancels just this suggestion, not the whole modal -- the
        // transcript, Explain's result, and both action buttons all stay
        // put and usable.
        btn.setButtonText("Cancel").onClick(() => this.suggestResultEl.empty())
      )
      .addButton((btn) =>
        btn
          .setButtonText("Apply")
          .setCta()
          .onClick(() => {
            this.onApplyFix(suggestion.command);
            this.close();
          })
      );
  }
}
