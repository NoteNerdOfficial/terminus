import { App, PluginSettingTab, Setting } from "obsidian";
import { getEnvVar } from "terminus-node-bridge";
import { isFontAvailable, isFontMonospaced, listAvailableMonospaceFonts } from "./terminal/fontCatalog";
import type TerminusPlugin from "./main";

/** Sentinel dropdown value -- can't collide with a real family name, which
 *  is why it isn't just the empty string (that one means "inherit"). */
const CUSTOM_FONT_VALUE = "__terminus_custom_font__";

export type TerminalPlacement = "ask" | "tab" | "split-right" | "split-down" | "window";

export const TERMINAL_PLACEMENT_LABELS: Record<TerminalPlacement, string> = {
  ask: "Always ask",
  tab: "New tab",
  "split-right": "Split right",
  "split-down": "Split down",
  window: "New window",
};

export type CursorStyle = "block" | "bar" | "underline";

export const CURSOR_STYLE_LABELS: Record<CursorStyle, string> = {
  block: "Block",
  bar: "Bar",
  underline: "Underline",
};

export type WikiLinkInsertFormat = "wikilink" | "vault-relative" | "absolute";

export const WIKI_LINK_INSERT_FORMAT_LABELS: Record<WikiLinkInsertFormat, string> = {
  wikilink: "Wiki-link ([[Note]])",
  "vault-relative": "Vault-relative path",
  absolute: "Absolute path",
};

export interface TerminusSettings {
  fontSize: number;
  terminalPlacement: TerminalPlacement;
  autoRevealPendingChanges: boolean;
  autoRevealDelayMs: number;
  confirmBulkActions: boolean;
  shellBinOverride: string;
  python3BinOverride: string;
  fontFamilyOverride: string;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollbackLines: number;
  autoThemeTerminal: boolean;
  startupCommand: string;
  ribbonIcon: string;
  wikiLinkInsertFormat: WikiLinkInsertFormat;
  /** Gates the first-run welcome modal to exactly one appearance, ever.
   *  Defaults false so an existing install shows it once on upgrade too --
   *  the shortcuts it covers are just as undiscovered there. */
  hasSeenWelcome: boolean;
}

export const DEFAULT_SETTINGS: TerminusSettings = {
  fontSize: 13,
  terminalPlacement: "ask",
  autoRevealPendingChanges: true,
  autoRevealDelayMs: 800,
  confirmBulkActions: false,
  shellBinOverride: "",
  python3BinOverride: "",
  fontFamilyOverride: "",
  cursorStyle: "block",
  cursorBlink: true,
  scrollbackLines: 1000,
  autoThemeTerminal: true,
  startupCommand: "",
  ribbonIcon: "square-terminal",
  wikiLinkInsertFormat: "wikilink",
  hasSeenWelcome: false,
};

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

export const MIN_AUTO_REVEAL_DELAY_MS = 0;
export const MAX_AUTO_REVEAL_DELAY_MS = 5000;

export const MIN_SCROLLBACK_LINES = 200;
export const MAX_SCROLLBACK_LINES = 50000;

export class TerminusSettingTab extends PluginSettingTab {
  /** Sticky only while the tab is open. Without it, picking "Custom" would
   *  immediately collapse back to the dropdown, since an empty override is
   *  indistinguishable from "inherit" once the tab re-renders. */
  private fontCustomMode = false;

  constructor(app: App, private plugin: TerminusPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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

    new Setting(containerEl).setName("Terminal appearance").setHeading();

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

    this.displayFontFamilySetting(containerEl);

    new Setting(containerEl)
      .setName("Cursor style")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(CURSOR_STYLE_LABELS)
          .setValue(this.plugin.settings.cursorStyle)
          .onChange(async (value) => {
            await this.plugin.setCursorStyle(value as CursorStyle);
          })
      );

    new Setting(containerEl)
      .setName("Cursor blink")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.cursorBlink).onChange(async (value) => {
          await this.plugin.setCursorBlink(value);
        })
      );

    new Setting(containerEl)
      .setName("Scrollback")
      .setDesc(`How many lines of history each terminal keeps in memory (${MIN_SCROLLBACK_LINES}-${MAX_SCROLLBACK_LINES}). Applies to newly opened terminals.`)
      .addSlider((slider) =>
        slider
          .setLimits(MIN_SCROLLBACK_LINES, MAX_SCROLLBACK_LINES, 100)
          .setValue(this.plugin.settings.scrollbackLines)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.scrollbackLines = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto theme")
      .setDesc("Terminal colors follow Obsidian's light/dark toggle. Turn off to use xterm.js's own default palette instead.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoThemeTerminal).onChange(async (value) => {
          await this.plugin.setAutoThemeTerminal(value);
        })
      );

    new Setting(containerEl)
      .setName("Startup command")
      .setDesc('Runs automatically in every new terminal once the shell is ready (e.g. "claude"). Leave blank for none.')
      .addText((text) =>
        text
          .setPlaceholder("e.g. claude")
          .setValue(this.plugin.settings.startupCommand)
          .onChange(async (value) => {
            this.plugin.settings.startupCommand = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Wiki-link autocomplete format")
      .setDesc('Format inserted when picking a note after typing "[[" in a terminal.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(WIKI_LINK_INSERT_FORMAT_LABELS)
          .setValue(this.plugin.settings.wikiLinkInsertFormat)
          .onChange(async (value) => {
            this.plugin.settings.wikiLinkInsertFormat = value as WikiLinkInsertFormat;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Ribbon icon")
      .setDesc("Any Lucide icon name (e.g. \"square-terminal\", \"terminal\"). Invalid names fall back to Obsidian's default icon silently.")
      .addText((text) =>
        text
          .setPlaceholder("square-terminal")
          .setValue(this.plugin.settings.ribbonIcon)
          .onChange(async (value) => {
            await this.plugin.setRibbonIcon(value.trim() || DEFAULT_SETTINGS.ribbonIcon);
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
        `Leave blank to auto-detect (your $SHELL, currently resolves to "${getEnvVar("SHELL") || "/bin/zsh"}" if unset). Only needed if the terminal opens the wrong shell.`
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

  /**
   * A dropdown of installed monospace fonts rather than free text.
   *
   * The old text field made it trivially easy to type a proportional font
   * ("Inter"), which a terminal cannot render sanely -- every glyph gets
   * painted into a fixed-width cell sized from the font's widest character,
   * so narrow letters end up marooned in the middle of theirs. It reads as
   * a plugin bug and isn't fixable at the terminal end; the honest fix is
   * to offer fonts that work. Custom entry stays available (Nerd Font
   * builds are too numerous and too locally-named to enumerate) but warns
   * when the family it's given won't align.
   */
  private displayFontFamilySetting(containerEl: HTMLElement): void {
    const availableFonts = listAvailableMonospaceFonts();
    const current = this.plugin.settings.fontFamilyOverride.trim();
    // A value saved before this dropdown existed (or a Nerd Font that isn't
    // on the curated list) must not be silently dropped just because it has
    // no matching option -- it opens in custom mode instead.
    const isCustom = this.fontCustomMode || (current !== "" && !availableFonts.includes(current));

    const options: Record<string, string> = { "": "Match Obsidian's monospace font" };
    for (const font of availableFonts) options[font] = font;
    options[CUSTOM_FONT_VALUE] = "Custom…";

    new Setting(containerEl)
      .setName("Font family")
      .setDesc(
        "Monospace fonts detected on this system. Applies to all open terminal panels. Proportional fonts aren't listed -- a terminal aligns text to a fixed character grid, which only a monospace font can sit in evenly."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(options)
          .setValue(isCustom ? CUSTOM_FONT_VALUE : current)
          .onChange(async (value) => {
            if (value === CUSTOM_FONT_VALUE) {
              this.fontCustomMode = true;
              // Re-render rather than toggling the field's visibility: the
              // same pattern the auto-reveal delay slider below already
              // uses for its own conditional setting.
              this.display();
              return;
            }
            this.fontCustomMode = false;
            await this.plugin.setFontFamilyOverride(value);
            this.display();
          })
      );

    if (!isCustom) return;

    const customSetting = new Setting(containerEl)
      .setName("Custom font family")
      .setDesc("Any font installed on this system, by its exact name.");
    // Lives in its own element so it can be rewritten on each keystroke
    // without re-rendering the whole tab (which would drop input focus).
    const warningEl = customSetting.descEl.createDiv({ cls: "terminus-setting-warning" });
    const refreshWarning = (value: string) => {
      warningEl.setText(this.describeCustomFontProblem(value));
    };
    refreshWarning(current);

    customSetting.addText((text) =>
      text
        .setPlaceholder("e.g. MesloLGS NF")
        .setValue(current)
        .onChange(async (value) => {
          const trimmed = value.trim();
          refreshWarning(trimmed);
          await this.plugin.setFontFamilyOverride(trimmed);
        })
    );
  }

  /** Empty string when there's nothing worth saying -- an always-present
   *  warning line trains people to ignore it. */
  private describeCustomFontProblem(family: string): string {
    if (!family) return "";
    if (!isFontAvailable(family)) {
      return `"${family}" doesn't appear to be installed -- the terminal will silently fall back to another font.`;
    }
    if (!isFontMonospaced(family)) {
      return `"${family}" isn't monospaced. Terminal output will look unevenly spaced and columns won't line up.`;
    }
    return "";
  }
}
