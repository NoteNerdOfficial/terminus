import { App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_GROUPS_DATA, GroupsData, resolveGroupsData } from "./state/GroupStore";
import { getEnvVar } from "terminus-node-bridge";
import { isFontAvailable, isFontMonospaced, listAvailableMonospaceFonts } from "./terminal/fontCatalog";
import { testClaudeConnection } from "./claude/headlessAssist";
import { errorMessage } from "./util/errors";
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

/** Every concrete placement, in menu order -- shared by the ribbon's
 *  "Always ask" menu and the per-placement palette commands. */
export const TERMINAL_OPEN_PLACEMENTS: Exclude<TerminalPlacement, "ask">[] = ["tab", "split-right", "split-down", "window"];

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

/** Classic is the single Pending Changes panel; Multi-agent is the Agent
 *  inbox plus the Terminus sidebar's groups. Terminals, pending changes and
 *  every setting outside the two per-mode objects below are shared. */
export type Experience = "classic" | "multi-agent";

export const EXPERIENCE_LABELS: Record<Experience, string> = {
  classic: "Classic",
  "multi-agent": "Multi-agent",
};

/** Set at build time by esbuild.config.mjs: true unless built with
 *  TERMINUS_MULTI_AGENT=0 (a Classic-only build). */
declare const TERMINUS_MULTI_AGENT_AVAILABLE: boolean;

/** When off (a Classic-only build), the Experience setting and the
 *  Multi-agent notices stay hidden and every install runs Classic, whatever
 *  its saved `experience` says. */
export const MULTI_AGENT_AVAILABLE: boolean = TERMINUS_MULTI_AGENT_AVAILABLE;

export interface ClassicSettings {
  autoRevealPendingChanges: boolean;
  autoRevealDelayMs: number;
}

export type SendBehavior = "steer" | "queue";

export interface MultiAgentSettings {
  autoRevealInbox: boolean;
  autoRevealDelayMs: number;
  /** Installs the SubagentStart/SubagentStop hooks and the Agent matcher. */
  trackSubagents: boolean;
  /** A terminal restored after a restart picks its Claude session back up
   *  (`claude --resume`). See TerminalView's claudeSession. */
  resumeSessions: boolean;
  /** What Cmd/Ctrl+Enter does in an inbox card's "Tell this session…" box:
   *  steer sends the text into the running turn now, queue holds it until
   *  the turn ends. Cmd/Ctrl+Shift+Enter does the other. */
  sendBehavior: SendBehavior;
  showEstimatedCost: boolean;
  showGitBranch: boolean;
  /** Reads `git status` at each turn's start and end to notice files Claude
   *  changed through the shell, which the Edit/Write/NotebookEdit hooks
   *  can't see (see git/gitStatus.ts). Two git calls per turn, and nothing
   *  at all outside a repo. */
  detectShellChanges: boolean;
  /** Writes one note per Claude session into the vault, a section per turn
   *  (see state/SessionLog.ts). Off by default and never turned on by
   *  anything but the user: it is the only part of Terminus that puts
   *  prompt text on disk, which ActionLog deliberately does not. */
  logSessions: boolean;
  /** Vault folder for those notes; blank falls back to the default. */
  sessionLogFolder: string;
  /** The log folder a Bases view has already been written into. Kept as the
   *  folder rather than a flag so both cases behave: deleting the view is a
   *  decision that sticks, and pointing the setting at a new folder gets a
   *  view in that one. Blank until the first session note is written. */
  sessionBaseFolder: string;
  /** Asks GitHub for the latest release (the sidebar's update link). Off by
   *  default: with it off, Terminus makes no network requests at all. */
  checkForUpdates: boolean;
}

export interface TerminusSettings {
  experience: Experience;
  /** Each mode's own settings, kept while the other mode is selected so
   *  switching back finds them as they were. */
  classic: ClassicSettings;
  multiAgent: MultiAgentSettings;
  fontSize: number;
  terminalPlacement: TerminalPlacement;
  confirmBulkActions: boolean;
  shellBinOverride: string;
  python3BinOverride: string;
  claudeAuthToken: string;
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
  /** Same one-time gate as hasSeenWelcome, for the invite to try
   *  Multi-agent. Set whether it was accepted or dismissed. */
  hasSeenMultiAgentInvite: boolean;
  /** Set once Multi-agent has become this install's default: a new install
   *  starts in it, and an existing one that never chose is moved to it once
   *  (see main.ts's applyMultiAgentDefault). */
  hasSeenMultiAgentDefault: boolean;
  /** Multi-agent's terminal groups (see GroupStore). Kept while Classic is
   *  selected, like the per-mode settings. */
  groups: GroupsData;
}

export const DEFAULT_CLASSIC_SETTINGS: ClassicSettings = {
  autoRevealPendingChanges: true,
  autoRevealDelayMs: 800,
};

export const DEFAULT_MULTI_AGENT_SETTINGS: MultiAgentSettings = {
  autoRevealInbox: true,
  autoRevealDelayMs: 800,
  trackSubagents: true,
  resumeSessions: true,
  sendBehavior: "steer",
  showEstimatedCost: true,
  showGitBranch: true,
  detectShellChanges: true,
  logSessions: false,
  sessionLogFolder: "Terminus/Sessions",
  sessionBaseFolder: "",
  checkForUpdates: false,
};

export const DEFAULT_SETTINGS: TerminusSettings = {
  experience: "multi-agent",
  classic: DEFAULT_CLASSIC_SETTINGS,
  multiAgent: DEFAULT_MULTI_AGENT_SETTINGS,
  fontSize: 13,
  terminalPlacement: "ask",
  confirmBulkActions: false,
  shellBinOverride: "",
  python3BinOverride: "",
  claudeAuthToken: "",
  fontFamilyOverride: "",
  cursorStyle: "block",
  cursorBlink: true,
  scrollbackLines: 1000,
  autoThemeTerminal: true,
  startupCommand: "",
  ribbonIcon: "square-terminal",
  wikiLinkInsertFormat: "wikilink",
  hasSeenWelcome: false,
  hasSeenMultiAgentInvite: false,
  hasSeenMultiAgentDefault: false,
  groups: DEFAULT_GROUPS_DATA,
};

/** Fields that lived at the top level before the per-mode split, and now
 *  belong to Classic. */
interface LegacyFlatSettings {
  autoRevealPendingChanges?: boolean;
  autoRevealDelayMs?: number;
}

/**
 * Builds the in-memory settings from whatever data.json holds. A plain
 * shallow merge isn't enough: it would take a saved `classic` object as-is
 * and drop any default added to it later, so each per-mode object is merged
 * with its own defaults. Settings saved before the split have no `classic`
 * at all; their flat auto-reveal fields move into it.
 */
export function resolveSettings(saved: unknown): TerminusSettings {
  const data = (typeof saved === "object" && saved !== null ? saved : {}) as Partial<TerminusSettings> & LegacyFlatSettings;
  const { autoRevealPendingChanges, autoRevealDelayMs, classic, multiAgent, groups, ...rest } = data;

  const legacyClassic: Partial<ClassicSettings> = {};
  if (autoRevealPendingChanges !== undefined) legacyClassic.autoRevealPendingChanges = autoRevealPendingChanges;
  if (autoRevealDelayMs !== undefined) legacyClassic.autoRevealDelayMs = autoRevealDelayMs;

  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    classic: { ...DEFAULT_CLASSIC_SETTINGS, ...legacyClassic, ...classic },
    multiAgent: { ...DEFAULT_MULTI_AGENT_SETTINGS, ...multiAgent },
    groups: resolveGroupsData(groups),
  };
}

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

  /** Shared by both modes' sections: the setting itself is shared. */
  private renderConfirmBulkActions(containerEl: HTMLElement): void {
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
  }

  /** Same slider for both modes, each writing its own value. */
  private renderRevealDelay(containerEl: HTMLElement, value: number, desc: string, save: (value: number) => void): void {
    new Setting(containerEl)
      .setName("Reveal delay")
      .setDesc(desc)
      .addSlider((slider) =>
        slider
          .setLimits(MIN_AUTO_REVEAL_DELAY_MS, MAX_AUTO_REVEAL_DELAY_MS, 100)
          .setValue(value)
          .setDynamicTooltip()
          .onChange(async (v) => {
            save(v);
            await this.plugin.saveSettings();
          })
      );
  }

  private renderClassicSection(containerEl: HTMLElement): void {
    const classic = this.plugin.settings.classic;
    new Setting(containerEl).setName("Review").setHeading();

    new Setting(containerEl)
      .setName("Automatically reveal Pending Changes panel")
      .setDesc(
        "Bring the panel to front once Claude finishes a burst of edits, so a review is never sitting there unnoticed."
      )
      .addToggle((toggle) =>
        toggle.setValue(classic.autoRevealPendingChanges).onChange(async (value) => {
          classic.autoRevealPendingChanges = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (classic.autoRevealPendingChanges) {
      this.renderRevealDelay(
        containerEl,
        classic.autoRevealDelayMs,
        "How long to wait after the last edit in a burst before revealing the panel, so a multi-file turn doesn't pop it up repeatedly.",
        (v) => (classic.autoRevealDelayMs = v)
      );
    }

    this.renderConfirmBulkActions(containerEl);
  }

  private renderMultiAgentSection(containerEl: HTMLElement): void {
    const multiAgent = this.plugin.settings.multiAgent;
    new Setting(containerEl).setName("Agents and review").setHeading();

    new Setting(containerEl)
      .setName("Automatically reveal Agent inbox")
      .setDesc("Bring the inbox to front once Claude finishes a burst of edits or needs your attention.")
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.autoRevealInbox).onChange(async (value) => {
          multiAgent.autoRevealInbox = value;
          await this.plugin.saveSettings();
          this.display();
        })
      );

    if (multiAgent.autoRevealInbox) {
      this.renderRevealDelay(
        containerEl,
        multiAgent.autoRevealDelayMs,
        "How long to wait after the last edit in a burst before revealing the inbox, so a multi-file turn doesn't pop it up repeatedly.",
        (v) => (multiAgent.autoRevealDelayMs = v)
      );
    }

    this.renderConfirmBulkActions(containerEl);

    new Setting(containerEl)
      .setName("Track subagents")
      .setDesc(
        "Show each subagent Claude starts as a row on its session's card, with the changes it made. Turning this off removes the subagent hooks from .claude/settings.local.json and credits every change to the main session."
      )
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.trackSubagents).onChange(async (value) => {
          await this.plugin.setTrackSubagents(value);
        })
      );

    new Setting(containerEl)
      .setName("Resume Claude sessions on reopen")
      .setDesc(
        "When Obsidian reopens (after quitting, a crash or a restart), each terminal that had Claude running picks up the same conversation. Terminals in settled or snoozed groups aren't resumed. Quitting Claude yourself means it isn't resumed."
      )
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.resumeSessions).onChange(async (value) => {
          multiAgent.resumeSessions = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Default for messages to a running session")
      .setDesc(
        "What Cmd/Ctrl+Enter does in an inbox card's message box. Steer sends it into the turn Claude is working on; Queue holds it until the turn ends, then sends queued messages one turn at a time. Cmd/Ctrl+Shift+Enter does the other."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("steer", "Steer")
          .addOption("queue", "Queue")
          .setValue(multiAgent.sendBehavior)
          .onChange(async (value) => {
            multiAgent.sendBehavior = value === "queue" ? "queue" : "steer";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show estimated cost")
      .setDesc(
        'Show an approximate cost ("≈ $0.42") from a built-in price table that is updated with each release. Off leaves tokens and context only.'
      )
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.showEstimatedCost).onChange(async (value) => {
          multiAgent.showEstimatedCost = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTerminusViews();
        })
      );

    new Setting(containerEl)
      .setName("Show git branch on cards")
      .setDesc("When a session's folder is a git repository, show its current branch on the session's card.")
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.showGitBranch).onChange(async (value) => {
          multiAgent.showGitBranch = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTerminusViews();
        })
      );

    new Setting(containerEl)
      .setName("Detect shell changes")
      .setDesc(
        "Claude's Edit and Write tools are the only ones Terminus can snapshot. This reads git status at the start and end of each turn so files Claude changed another way -- a formatter, sed, a package manager -- are at least listed on its card. Two git calls per turn, and nothing outside a git repository."
      )
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.detectShellChanges).onChange(async (value) => {
          multiAgent.detectShellChanges = value;
          await this.plugin.saveSettings();
          this.plugin.refreshTerminusViews();
        })
      );

    new Setting(containerEl)
      .setName("Log sessions to notes")
      .setDesc(
        "Writes one note per Claude session into your vault, a section appended as each turn ends: the prompt, the files that turn changed and by how much, how long it took, and anything it changed outside Claude's edit tools. Entirely deterministic -- every line comes from a hook payload, nothing is summarised by a model, so there is no token cost. Off by default because it is the only part of Terminus that writes your prompts to disk, in full as Claude Code reported them."
      )
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.logSessions).onChange(async (value) => {
          multiAgent.logSessions = value;
          await this.plugin.saveSettings();
          // Shown and hidden in place rather than through display(): this
          // setting is near the bottom of a long tab, and a re-render would
          // throw the panel back to the top under the user's cursor.
          folderSetting?.settingEl.toggle(value);
        })
      );

    // A folder for notes nothing is writing is a setting with no effect, so
    // it follows the toggle above.
    const folderSetting = new Setting(containerEl)
      .setName("Session log folder")
      .setDesc(
        "Where those notes go. Created if it isn't there; one note per session, named by date, time and terminal. Each note records its goal, status, branch and totals in frontmatter -- so a Bases view is dropped in alongside them, with Recent, Unfinished and By branch views. Delete the view if you'd rather not have it and it won't come back; point this at another folder and that one gets its own."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_MULTI_AGENT_SETTINGS.sessionLogFolder)
          .setValue(multiAgent.sessionLogFolder)
          .onChange(async (value) => {
            multiAgent.sessionLogFolder = value;
            await this.plugin.saveSettings();
          })
      );
    folderSetting.settingEl.toggle(multiAgent.logSessions);

    new Setting(containerEl)
      .setName("Check for updates")
      .setDesc(
        "Ask GitHub for the latest release at startup and twice a day, and show an update link next to the version in the sidebar. While this is off, the plugin makes no network requests."
      )
      .addToggle((toggle) =>
        toggle.setValue(multiAgent.checkForUpdates).onChange(async (value) => {
          await this.plugin.setCheckForUpdates(value);
        })
      );
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    if (MULTI_AGENT_AVAILABLE) {
      new Setting(containerEl)
        .setName("Experience")
        .setDesc(
          "Classic reviews every terminal's changes in one Pending Changes panel. Multi-agent adds an Agent inbox with a card per Claude session, and groups for your terminals. Each keeps its own review settings below; the rest are shared."
        )
        .addDropdown((dropdown) =>
          dropdown
            .addOptions(EXPERIENCE_LABELS)
            .setValue(this.plugin.settings.experience)
            .onChange(async (value) => {
              await this.plugin.setExperience(value as Experience);
              this.display();
            })
        );
    }


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

    if (this.plugin.experience === "multi-agent") {
      this.renderMultiAgentSection(containerEl);
    } else {
      this.renderClassicSection(containerEl);
    }

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

    this.displayClaudeAuthTokenSetting(containerEl);
  }

  /** Settings apply immediately -- `getClaudeBin()`/`this.plugin.settings`
   *  are both read live by every headless call, nothing here is cached --
   *  so "Test" always reflects the field's current saved value with no
   *  restart or reload needed. Its own status line is a separate element
   *  (same pattern as the custom-font warning below) so a click doesn't
   *  need a full `display()` re-render, which would drop input focus. */
  private displayClaudeAuthTokenSetting(containerEl: HTMLElement): void {
    let statusEl: HTMLElement;

    const setting = new Setting(containerEl)
      .setName("Claude Code auth token")
      .setDesc(
        'Only needed for "Explain this" / "Suggest a fix" on failed commands, and only if those hang or fail outright -- some machines can\'t read Claude Code\'s normal Keychain-based login from a spawned background process. Run "claude setup-token" in a real terminal and paste the result here. Leave blank to keep using your regular Claude Code login. Stored as plain text in this vault\'s plugin data, same as any other API key field.'
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-ant-oat01-…")
          .setValue(this.plugin.settings.claudeAuthToken)
          .onChange(async (value) => {
            this.plugin.settings.claudeAuthToken = value.trim();
            await this.plugin.saveSettings();
            statusEl.empty();
            statusEl.removeClass("is-success", "is-error");
          });
      })
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          statusEl.removeClass("is-success", "is-error");
          statusEl.setText("Testing…");
          try {
            const claudeBin = await this.plugin.getClaudeBin();
            await testClaudeConnection(claudeBin, this.plugin.settings.claudeAuthToken || undefined);
            statusEl.setText("Connected -- Explain this / Suggest a fix should work now.");
            statusEl.addClass("is-success");
          } catch (err) {
            statusEl.setText(`Failed: ${errorMessage(err)}`);
            statusEl.addClass("is-error");
          } finally {
            button.setDisabled(false);
          }
        })
      );

    statusEl = setting.descEl.createDiv({ cls: "terminus-setting-status" });
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
