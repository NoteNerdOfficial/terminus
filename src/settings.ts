import { App, PluginSettingTab, Setting } from "obsidian";
import type TerminusPlugin from "./main";

export type TerminalPlacement = "ask" | "tab" | "split-right" | "split-down" | "window";

export const TERMINAL_PLACEMENT_LABELS: Record<TerminalPlacement, string> = {
  ask: "Always ask",
  tab: "New tab",
  "split-right": "Split right",
  "split-down": "Split down",
  window: "New window",
};

export interface TerminusSettings {
  fontSize: number;
  terminalPlacement: TerminalPlacement;
  autoRevealPendingChanges: boolean;
  autoRevealDelayMs: number;
  confirmBulkActions: boolean;
  shellBinOverride: string;
  python3BinOverride: string;
}

export const DEFAULT_SETTINGS: TerminusSettings = {
  fontSize: 13,
  terminalPlacement: "ask",
  autoRevealPendingChanges: true,
  autoRevealDelayMs: 800,
  confirmBulkActions: false,
  shellBinOverride: "",
  python3BinOverride: "",
};

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export const MIN_AUTO_REVEAL_DELAY_MS = 0;
export const MAX_AUTO_REVEAL_DELAY_MS = 5000;

export class TerminusSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TerminusPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Terminal font size")
      .setDesc(
        `Applies to all open terminal panels. Also adjustable via the "Increase/Decrease terminal font size" commands (${MIN_FONT_SIZE}-${MAX_FONT_SIZE}px).`
      )
      .addSlider((slider) =>
        slider
          .setLimits(MIN_FONT_SIZE, MAX_FONT_SIZE, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.setFontSize(value);
          })
      );

    new Setting(containerEl)
      .setName("New terminal placement")
      .setDesc(
        'Where the ribbon icon and "Open Terminus" command open a new terminal. "Always ask" shows a quick menu at the click; any other choice opens directly there every time.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(TERMINAL_PLACEMENT_LABELS)
          .setValue(this.plugin.settings.terminalPlacement)
          .onChange(async (value) => {
            this.plugin.settings.terminalPlacement = value as TerminalPlacement;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Automatically reveal Pending Changes panel")
      .setDesc(
        "Bring the panel to front once Claude finishes a burst of edits, so a review is never sitting there unnoticed."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoRevealPendingChanges).onChange(async (value) => {
          this.plugin.settings.autoRevealPendingChanges = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (this.plugin.settings.autoRevealPendingChanges) {
      new Setting(containerEl)
        .setName("Reveal delay")
        .setDesc(
          "How long to wait after the last edit in a burst before revealing the panel, so a multi-file turn doesn't pop it up repeatedly."
        )
        .addSlider((slider) =>
          slider
            .setLimits(MIN_AUTO_REVEAL_DELAY_MS, MAX_AUTO_REVEAL_DELAY_MS, 100)
            .setValue(this.plugin.settings.autoRevealDelayMs)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.autoRevealDelayMs = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Confirm before bulk actions")
      .setDesc(
        'Ask for confirmation before "Reject all" / "Keep all" (global or per-terminal). Off by default -- every bulk action is already reversible via the "Recently resolved" list.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.confirmBulkActions).onChange(async (value) => {
          this.plugin.settings.confirmBulkActions = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Shell binary override")
      .setDesc(
        `Leave blank to auto-detect (your $SHELL, currently resolves to "${process.env.SHELL || "/bin/zsh"}" if unset). Only needed if the terminal opens the wrong shell.`
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. /bin/zsh")
          .setValue(this.plugin.settings.shellBinOverride)
          .onChange(async (value) => {
            this.plugin.settings.shellBinOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Python 3 binary override")
      .setDesc(
        "Leave blank to auto-detect. Only needed if the plugin can't find python3 on its own (used to allocate the terminal's pseudo-terminal)."
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. /usr/local/bin/python3")
          .setValue(this.plugin.settings.python3BinOverride)
          .onChange(async (value) => {
            this.plugin.settings.python3BinOverride = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
