import { Menu, Notice, Plugin, WorkspaceLeaf, setIcon } from "obsidian";
import { pathBasename, pathJoin } from "terminus-node-bridge";
import { ReviewServer } from "./server/ReviewServer";
import { provisionClaudeSettings, getVaultBasePath, getHookBridgePath } from "./hooks/provisionSettings";
import { provisionResources } from "./hooks/provisionResources";
import { resolvePython3, resolveUserShell } from "./pty/shellDetect";
import { resolveClaudeBin } from "./claude/headlessAssist";
import { TERMINUS_VIEW_TYPE, TerminalView } from "./views/TerminalView";
import { PENDING_CHANGES_VIEW_TYPE, PendingChangesView } from "./views/PendingChangesView";
import { DIFF_SPLIT_VIEW_TYPE, DiffSplitView } from "./views/DiffSplitView";
import { PendingChangesStore, ResolvedChange } from "./state/PendingChangesStore";
import { ActionLog } from "./state/ActionLog";
import { ClosedTerminalBuffer, ClosedTerminalEntry } from "./state/ClosedTerminalBuffer";
import { ActionLogModal } from "./modals/ActionLogModal";
import { ConfirmModal } from "./modals/ConfirmModal";
import { RescueClosedTerminalModal } from "./modals/RescueClosedTerminalModal";
import { computeDiffStats } from "./diff/renderDiff";
import { inlineDiffDecorations, inlineDiffField } from "./editor/inlineDiff";
import { errorMessage } from "./util/errors";
import {
  DEFAULT_SETTINGS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TerminusSettingTab,
  TerminusSettings,
  TerminalPlacement,
  TERMINAL_PLACEMENT_LABELS,
  CursorStyle,
} from "./settings";

export default class TerminusPlugin extends Plugin {
  readonly reviewServer = new ReviewServer();
  readonly pendingChangesStore = new PendingChangesStore();
  readonly closedTerminals = new ClosedTerminalBuffer();
  // Constructed in onload(), not as a field initializer: the log file path
  // depends on the vault base path, which needs `this.app` to be ready --
  // safer to compute once Obsidian has fully set that up, not during
  // construction.
  actionLog!: ActionLog;
  settings: TerminusSettings = DEFAULT_SETTINGS;
  private python3Bin: string | null = null;
  private claudeBin: string | null = null;
  private nextTerminalNumber = 1;
  private revealPendingChangesTimer: number | null = null;
  private ribbonIconEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new TerminusSettingTab(this.app, this));

    // Obsidian's own installer never delivers resources/ (see
    // provisionResources.ts's own doc comment) -- write it out ourselves,
    // before anything that spawns a PTY or provisions the Claude hook could
    // possibly run.
    await provisionResources(this.getPluginDir());

    this.actionLog = new ActionLog(pathJoin(this.getPluginDir(), "action-log.json"));
    await this.actionLog.load();
    this.pendingChangesStore.on("resolved", (item: ResolvedChange) => {
      const stats = computeDiffStats(item.diff);
      void this.actionLog.append({
        timestamp: item.resolvedAt,
        filePath: item.diff.filePath,
        accepted: item.accepted,
        editCount: item.editCount,
        added: stats.added,
        removed: stats.removed,
        toolName: item.payload.tool_name,
      });
    });

    // Claude often makes several edits in one turn (recordChange fires once
    // per file touched); debounce so the panel comes to front once, shortly
    // after the last edit in that burst settles, rather than repeatedly
    // stealing focus mid-turn.
    this.pendingChangesStore.on("recorded", () => {
      if (!this.settings.autoRevealPendingChanges) return;
      if (this.revealPendingChangesTimer) window.clearTimeout(this.revealPendingChangesTimer);
      this.revealPendingChangesTimer = window.setTimeout(() => {
        this.revealPendingChangesTimer = null;
        void this.revealPendingChangesView();
      }, this.settings.autoRevealDelayMs);
    });

    await this.reviewServer.start();

    try {
      await provisionClaudeSettings(this.app, this.manifest);
    } catch (err) {
      console.error("Terminus: failed to provision .claude/settings.local.json", err);
      new Notice(
        "Terminus: could not write .claude/settings.local.json -- diff review won't be wired up for claude. See console."
      );
    }

    this.registerEditorExtension([inlineDiffField, inlineDiffDecorations]);

    this.registerView(TERMINUS_VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
    this.registerView(PENDING_CHANGES_VIEW_TYPE, (leaf) => new PendingChangesView(leaf, this));
    this.registerView(DIFF_SPLIT_VIEW_TYPE, (leaf) => new DiffSplitView(leaf, this));

    this.ribbonIconEl = this.addRibbonIcon(this.settings.ribbonIcon, "Open Terminus", (evt) => {
      void this.openTerminal(evt);
    });

    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => void this.openTerminal(),
    });

    this.addCommand({
      id: "open-pending-changes",
      name: "Open Pending Changes",
      callback: () => void this.revealPendingChangesView(),
    });

    this.addCommand({
      id: "increase-terminal-font-size",
      name: "Increase terminal font size",
      callback: () => void this.setFontSize(this.settings.fontSize + 1),
    });
    this.addCommand({
      id: "decrease-terminal-font-size",
      name: "Decrease terminal font size",
      callback: () => void this.setFontSize(this.settings.fontSize - 1),
    });
    this.addCommand({
      id: "reset-terminal-font-size",
      name: "Reset terminal font size",
      callback: () => void this.setFontSize(DEFAULT_SETTINGS.fontSize),
    });

    this.addCommand({
      id: "accept-oldest-pending-change",
      name: "Accept oldest pending change",
      callback: () => void this.resolveOldestPendingChange(true),
    });
    this.addCommand({
      id: "reject-oldest-pending-change",
      name: "Reject oldest pending change",
      callback: () => void this.resolveOldestPendingChange(false),
    });
    this.addCommand({
      id: "keep-all-pending-changes",
      name: "Keep all pending changes",
      callback: () => void this.runBulkPendingChangesCommand(true),
    });
    this.addCommand({
      id: "reject-all-pending-changes",
      name: "Reject all pending changes",
      callback: () => void this.runBulkPendingChangesCommand(false),
    });

    this.addCommand({
      id: "open-action-log",
      name: "Open Action Log",
      callback: () => new ActionLogModal(this.app, this.actionLog).open(),
    });

    this.addCommand({
      id: "rescue-closed-terminal",
      name: "Rescue closed terminal",
      checkCallback: (checking) => {
        const entries = this.closedTerminals.list();
        if (checking) return entries.length > 0;
        if (entries.length > 0) {
          new RescueClosedTerminalModal(this.app, entries, (entry) => void this.rescueClosedTerminal(entry)).open();
        }
        return true;
      },
    });

    // Open the panel once on startup too, so it's already present (not just
    // revealed reactively once Claude's first change lands) if the user
    // goes looking for it.
    this.app.workspace.onLayoutReady(() => void this.revealPendingChangesView());
  }

  onunload(): void {
    if (this.revealPendingChangesTimer) window.clearTimeout(this.revealPendingChangesTimer);
    void this.reviewServer.stop();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<TerminusSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setFontSize(size: number): Promise<void> {
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
    if (clamped === this.settings.fontSize) return;
    this.settings.fontSize = clamped;
    await this.saveSettings();
    this.forEachTerminalView((view) => view.applyFontSize(clamped));
  }

  async setFontFamilyOverride(fontFamily: string): Promise<void> {
    this.settings.fontFamilyOverride = fontFamily;
    await this.saveSettings();
    this.forEachTerminalView((view) => view.applyFontFamily());
  }

  async setCursorStyle(style: CursorStyle): Promise<void> {
    this.settings.cursorStyle = style;
    await this.saveSettings();
    this.forEachTerminalView((view) => view.applyCursorStyle());
  }

  async setCursorBlink(blink: boolean): Promise<void> {
    this.settings.cursorBlink = blink;
    await this.saveSettings();
    this.forEachTerminalView((view) => view.applyCursorBlink());
  }

  async setAutoThemeTerminal(enabled: boolean): Promise<void> {
    this.settings.autoThemeTerminal = enabled;
    await this.saveSettings();
    this.forEachTerminalView((view) => view.applyTheme());
  }

  /** Falls back silently to Obsidian's default icon if the given name isn't
   *  a real Lucide icon -- `setIcon()` just renders nothing extra rather
   *  than throwing, so there's nothing to catch/validate here. */
  async setRibbonIcon(iconName: string): Promise<void> {
    this.settings.ribbonIcon = iconName;
    await this.saveSettings();
    if (this.ribbonIconEl) setIcon(this.ribbonIconEl, iconName);
    // Already-open terminal tabs keep whatever icon they opened with --
    // Obsidian doesn't expose a way to force a leaf's tab header to re-call
    // getIcon(), and this is cosmetic enough not to be worth reaching for a
    // private API over. New terminals pick up the change immediately.
  }

  private forEachTerminalView(fn: (view: TerminalView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(TERMINUS_VIEW_TYPE)) {
      if (leaf.view instanceof TerminalView) fn(leaf.view);
    }
  }

  /** Same confirm-before-bulk-actions gate as the panel's own Reject/Keep
   *  all buttons (see PendingChangesView.runBulkAction) -- these command-
   *  palette/hotkey entries are just as consequential, so they shouldn't
   *  bypass the setting just because they're triggered a different way. */
  private async runBulkPendingChangesCommand(accepted: boolean): Promise<void> {
    const count = this.pendingChangesStore.list().length;
    if (count === 0) {
      new Notice("Terminus: no pending changes");
      return;
    }
    if (this.settings.confirmBulkActions) {
      const verb = accepted ? "Keep" : "Reject";
      const confirmed = await ConfirmModal.confirm(
        this.app,
        `${verb} all pending changes?`,
        `This will ${accepted ? "keep" : "revert"} ${count} ${count === 1 ? "file" : "files"}.`,
        verb
      );
      if (!confirmed) return;
    }
    try {
      await this.pendingChangesStore.resolveAll(accepted);
    } catch (err) {
      new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} all changes: ${errorMessage(err)}`);
    }
  }

  private async resolveOldestPendingChange(accepted: boolean): Promise<void> {
    const oldest = this.pendingChangesStore.list()[0];
    if (!oldest) {
      new Notice("Terminus: no pending changes");
      return;
    }
    try {
      await this.pendingChangesStore.resolveItem(oldest.id, accepted);
      new Notice(`Terminus: ${accepted ? "kept" : "reverted"} ${pathBasename(oldest.diff.filePath)}`);
    } catch (err) {
      new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} ${pathBasename(oldest.diff.filePath)}: ${errorMessage(err)}`);
    }
  }

  async getPython3Bin(): Promise<string> {
    const override = this.settings.python3BinOverride.trim();
    if (override) return override;
    if (!this.python3Bin) this.python3Bin = await resolvePython3();
    return this.python3Bin;
  }

  /** Checked live against settings (not cached) -- unlike the async
   *  login-shell lookups below, this has nothing worth caching, and a
   *  settings change should take effect on the very next terminal opened. */
  getUserShell(): string {
    return this.settings.shellBinOverride.trim() || resolveUserShell();
  }

  async getClaudeBin(): Promise<string> {
    if (!this.claudeBin) this.claudeBin = await resolveClaudeBin();
    return this.claudeBin;
  }

  getVaultBasePath(): string {
    return getVaultBasePath(this.app);
  }

  getHookBridgePath(): string {
    return getHookBridgePath(this.app, this.manifest);
  }

  getPluginDir(): string {
    return pathJoin(this.getVaultBasePath(), this.app.vault.configDir, "plugins", this.manifest.id);
  }

  async revealPendingChangesView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(PENDING_CHANGES_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await leaf.setViewState({ type: PENDING_CHANGES_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** Ribbon clicks always carry a MouseEvent to anchor a placement menu to;
   *  a command-palette/hotkey invocation doesn't, so "Always ask" falls
   *  back to a plain new tab in that case rather than showing a menu with
   *  no sensible place to appear. */
  private async openTerminal(evt?: MouseEvent): Promise<void> {
    const placement = this.settings.terminalPlacement;
    if (placement === "ask" && evt) {
      this.showTerminalPlacementMenu(evt);
      return;
    }
    await this.openTerminalAt(placement === "ask" ? "tab" : placement);
  }

  private showTerminalPlacementMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const placements: Exclude<TerminalPlacement, "ask">[] = ["tab", "split-right", "split-down", "window"];
    for (const placement of placements) {
      menu.addItem((item) =>
        item.setTitle(TERMINAL_PLACEMENT_LABELS[placement]).onClick(() => void this.openTerminalAt(placement))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Always opens a NEW terminal -- multiple concurrent terminals (each
   *  running their own `claude` session) are supported; the hook/review
   *  plumbing already keys everything by each TerminalView's own random
   *  token, so this was purely a UI limitation (this used to dedupe against
   *  an existing terminal leaf). Reusing an existing terminal is just
   *  normal Obsidian tab-switching, not this command's job. */
  private async openTerminalAt(placement: Exclude<TerminalPlacement, "ask">): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf;
    switch (placement) {
      case "split-right":
        leaf = workspace.getLeaf("split", "vertical");
        break;
      case "split-down":
        leaf = workspace.getLeaf("split", "horizontal");
        break;
      case "window":
        leaf = workspace.getLeaf("window");
        break;
      case "tab":
      default:
        leaf = workspace.getLeaf("tab");
        break;
    }
    await leaf.setViewState({ type: TERMINUS_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  allocateTerminalNumber(): number {
    return this.nextTerminalNumber++;
  }

  private async rescueClosedTerminal(entry: ClosedTerminalEntry): Promise<void> {
    this.closedTerminals.remove(entry);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: TERMINUS_VIEW_TYPE,
      active: true,
      state: {
        scrollback: entry.scrollback,
        cwd: entry.cwd ?? undefined,
        customName: entry.customName ?? undefined,
        color: entry.color ?? undefined,
      },
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}
