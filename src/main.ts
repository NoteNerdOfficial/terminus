import { Menu, Notice, Plugin, WorkspaceLeaf, setIcon } from "obsidian";
import { pathBasename, pathJoin, pathRelative } from "terminus-node-bridge";
import { ReviewServer } from "./server/ReviewServer";
import { provisionClaudeSettings, getVaultBasePath, getHookBridgePath } from "./hooks/provisionSettings";
import { provisionResources } from "./hooks/provisionResources";
import { resolvePython3, resolveUserShell } from "./pty/shellDetect";
import { resolveClaudeBin } from "./claude/headlessAssist";
import { TERMINUS_VIEW_TYPE, TerminalView } from "./views/TerminalView";
import { PENDING_CHANGES_VIEW_TYPE, PendingChangesView } from "./views/PendingChangesView";
import { DIFF_SPLIT_VIEW_TYPE, DiffSplitView } from "./views/DiffSplitView";
import { AGENT_INBOX_VIEW_TYPE, AgentInboxView } from "./views/AgentInboxView";
import { TERMINUS_SIDEBAR_VIEW_TYPE, TerminusSidebarView } from "./views/TerminusSidebarView";
import { GroupStore } from "./state/GroupStore";
import { GroupController } from "./groups/GroupController";
import { GroupSuggestModal } from "./groups/GroupSuggestModal";
import { TabVisibility } from "./groups/TabVisibility";
import { TERMINAL_COLOR_PALETTE } from "./terminal/colorPalette";
import { fetchLatestPluginVersion, PluginVersionStatus, versionStatus } from "./pluginVersion";
import { PendingChangesStore, ResolvedChange } from "./state/PendingChangesStore";
import { ActionLog } from "./state/ActionLog";
import { AgentSessionStore } from "./state/AgentSessionStore";
import { TranscriptUsageReader, subagentTranscriptPath } from "./claude/transcriptUsage";
import { FeedbackStore } from "./state/FeedbackStore";
import { composeFeedbackPrompt } from "./claude/feedbackPrompt";
import { ClosedTerminalBuffer, ClosedTerminalEntry } from "./state/ClosedTerminalBuffer";
import { ActionLogModal } from "./modals/ActionLogModal";
import { ConfirmModal } from "./modals/ConfirmModal";
import { confirmCollisionReject, hasCollision } from "./modals/collisions";
import { RescueClosedTerminalModal } from "./modals/RescueClosedTerminalModal";
import { GettingStartedModal } from "./modals/GettingStartedModal";
import { MultiAgentInviteModal } from "./modals/MultiAgentInviteModal";
import { computeDiffStats } from "./diff/renderDiff";
import { inlineDiffDecorations, inlineDiffField } from "./editor/inlineDiff";
import { errorMessage } from "./util/errors";
import {
  DEFAULT_SETTINGS,
  Experience,
  MULTI_AGENT_AVAILABLE,
  resolveSettings,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TerminusSettingTab,
  TerminusSettings,
  TerminalPlacement,
  TERMINAL_PLACEMENT_LABELS,
  TERMINAL_OPEN_PLACEMENTS,
  CursorStyle,
} from "./settings";

export default class TerminusPlugin extends Plugin {
  readonly reviewServer = new ReviewServer();
  readonly pendingChangesStore = new PendingChangesStore();
  /** Each terminal's Claude session status, for the Agent inbox. */
  readonly agentSessionStore = new AgentSessionStore();
  /** Review comments queued per session (Multi-agent only). */
  readonly feedbackStore = new FeedbackStore();
  /** Multi-agent's terminal groups; created once settings are loaded. */
  groupStore!: GroupStore;
  readonly groups = new GroupController(this);
  readonly tabs = new TabVisibility(this);
  private groupStatusEl: HTMLElement | null = null;
  /** Latest release on GitHub, once checked (Multi-agent only). */
  private latestPluginVersion: string | null = null;
  /** Set first thing in onunload: views closing then aren't the user
   *  closing terminals, so groups mustn't be tidied away. */
  private unloading = false;
  private readonly transcriptUsage = new TranscriptUsageReader();
  /** Subagents whose usage was read after they ended: final, never re-read. */
  private finalSubagentUsage = new Set<string>();
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
    this.groupStore = new GroupStore(
      this.settings.groups,
      () => this.saveSettings(),
      TERMINAL_COLOR_PALETTE.map((option) => option.value)
    );
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
    // The invite to try Multi-agent rides the same debounce, so it never
    // interrupts a turn mid-burst either.
    this.pendingChangesStore.on("recorded", () => {
      const reveal = this.autoRevealSettings();
      if (!reveal.enabled && !this.shouldInviteToMultiAgent()) return;
      if (this.revealPendingChangesTimer) window.clearTimeout(this.revealPendingChangesTimer);
      this.revealPendingChangesTimer = window.setTimeout(() => {
        this.revealPendingChangesTimer = null;
        if (reveal.enabled) void this.revealReviewView();
        if (this.shouldInviteToMultiAgent()) void this.showMultiAgentInvite();
      }, reveal.delayMs);
    });

    await this.reviewServer.start();

    await this.provisionHooks();

    this.registerEditorExtension([inlineDiffField, inlineDiffDecorations]);

    this.registerView(TERMINUS_VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
    this.registerView(PENDING_CHANGES_VIEW_TYPE, (leaf) => new PendingChangesView(leaf, this));
    this.registerView(DIFF_SPLIT_VIEW_TYPE, (leaf) => new DiffSplitView(leaf, this));
    this.registerView(AGENT_INBOX_VIEW_TYPE, (leaf) => new AgentInboxView(leaf, this));
    this.registerView(TERMINUS_SIDEBAR_VIEW_TYPE, (leaf) => new TerminusSidebarView(leaf, this));

    // Opening a terminal from another group switches to that group.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (this.experience === "multi-agent") this.groups.onActiveLeaf(leaf);
      })
    );
    // New tabs, moved panes and closed tabs: re-apply which tabs show. Also
    // where terminals restored after startup get loaded (see
    // startMultiAgentViews).
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (this.experience === "multi-agent") void this.groups.loadDeferredTerminals();
        this.applyGroupVisibility();
      })
    );
    this.groupStore.on("change", () => this.applyGroupVisibility());
    // A note tab's right-click menu: put it in a group, or back in every group.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, _file, source, leaf) => {
        if (source === "tab-header" && leaf) this.addGroupMenuItems(menu, leaf);
      })
    );
    this.groupStatusEl = this.addStatusBarItem();
    this.groupStatusEl.addClass("terminus-group-status", "mod-clickable");
    this.groupStatusEl.addEventListener("click", () => {
      new GroupSuggestModal(this, "Switch to group", false, (choice) => {
        if (choice.kind === "group") void this.groups.selectGroup(choice.target);
      }).open();
    });
    // Twice a day, while the sidebar that shows it is in use.
    this.registerInterval(window.setInterval(() => void this.checkPluginVersion(), 12 * 60 * 60 * 1000));

    this.ribbonIconEl = this.addRibbonIcon(this.settings.ribbonIcon, "Open Terminus", (evt) => {
      void this.openTerminal(evt);
    });

    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => void this.openTerminal(),
    });
    for (const placement of TERMINAL_OPEN_PLACEMENTS) {
      this.addCommand({
        id: `open-${placement}`,
        name: `Open in ${TERMINAL_PLACEMENT_LABELS[placement].toLowerCase()}`,
        callback: () => void this.openTerminalAt(placement),
      });
    }

    // Each experience offers only its own review view.
    this.addCommand({
      id: "open-pending-changes",
      name: "Open Pending Changes",
      checkCallback: (checking) => {
        if (this.experience !== "classic") return false;
        if (!checking) void this.revealReviewView();
        return true;
      },
    });
    this.addCommand({
      id: "open-agent-inbox",
      name: "Open agent inbox",
      checkCallback: (checking) => {
        if (this.experience !== "multi-agent") return false;
        if (!checking) void this.revealReviewView();
        return true;
      },
    });
    this.addCommand({
      id: "new-group",
      name: "New group",
      checkCallback: (checking) => {
        if (this.experience !== "multi-agent") return false;
        if (!checking) {
          void this.groups.createGroup().then(async (group) => (await this.revealSidebar())?.startRename(group.id));
        }
        return true;
      },
    });
    this.addCommand({
      id: "switch-group",
      name: "Switch group…",
      checkCallback: (checking) => {
        if (this.experience !== "multi-agent" || this.groupStore.list().length === 0) return false;
        if (!checking) new GroupSuggestModal(this, "Switch to group", false, (choice) => {
            if (choice.kind === "group") void this.groups.selectGroup(choice.target);
          }).open();
        return true;
      },
    });
    this.addCommand({
      id: "move-terminal-to-group",
      name: "Move terminal to group…",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(TerminalView);
        if (this.experience !== "multi-agent" || !view) return false;
        if (!checking) {
          new GroupSuggestModal(this, "Move this terminal to", true, (choice) => {
            if (choice.kind === "new") {
              void this.groups.createGroup([view]).then(async (group) => (await this.revealSidebar())?.startRename(group.id));
            } else {
              this.groups.moveTerminals([view], choice.target);
            }
          }).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: "add-tab-to-group",
      name: "Add current tab to group…",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (this.experience !== "multi-agent" || !leaf || leaf.view instanceof TerminalView || this.groupStore.list().length === 0) return false;
        if (!checking) {
          new GroupSuggestModal(this, "Add this tab to", false, (choice) => {
            if (choice.kind === "group") this.addTabToGroup(leaf, choice.target, true);
          }).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: "close-group",
      name: "Close group",
      checkCallback: (checking) => {
        const groupId = this.groupStore?.activeGroupId;
        if (this.experience !== "multi-agent" || !groupId) return false;
        if (!checking) void this.closeGroupAsking(groupId);
        return true;
      },
    });
    this.addCommand({
      id: "next-session-needing-attention",
      name: "Jump to next session that needs attention",
      checkCallback: (checking) => {
        if (this.experience !== "multi-agent") return false;
        if (!checking) void this.jumpToNextSessionNeedingAttention();
        return true;
      },
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
      id: "getting-started",
      name: "Getting started",
      callback: () => GettingStartedModal.openGuide(this.app),
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
    this.app.workspace.onLayoutReady(() => {
      void this.revealReviewView();
      void this.showWelcomeIfFirstRun();
      if (this.experience === "multi-agent") void this.startMultiAgentViews();
    });
  }

  /** Fires at most once per install. The flag is persisted before the modal
   *  opens rather than after it's dismissed, so a crash or a force-quit
   *  while it's on screen can't turn it into a modal that greets the user
   *  on every single startup. */
  private async showWelcomeIfFirstRun(): Promise<void> {
    if (this.settings.hasSeenWelcome) return;
    this.settings.hasSeenWelcome = true;
    await this.saveSettings();
    GettingStartedModal.openWelcome(this.app);
  }

  onunload(): void {
    this.unloading = true;
    if (this.revealPendingChangesTimer) window.clearTimeout(this.revealPendingChangesTimer);
    void this.reviewServer.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = resolveSettings(await this.loadData());
  }

  /** The experience actually in effect: always Classic until Multi-agent
   *  ships (see MULTI_AGENT_AVAILABLE), whatever the saved setting says. */
  get experience(): Experience {
    return MULTI_AGENT_AVAILABLE ? this.settings.experience : "classic";
  }

  /** Whether subagents get their own record and their edits their own
   *  attribution: Multi-agent with "Track subagents" on. */
  get tracksSubagents(): boolean {
    return this.experience === "multi-agent" && this.settings.multiAgent.trackSubagents;
  }

  async setTrackSubagents(track: boolean): Promise<void> {
    if (track === this.settings.multiAgent.trackSubagents) return;
    this.settings.multiAgent.trackSubagents = track;
    await this.saveSettings();
    await this.provisionHooks();
  }

  async setExperience(experience: Experience): Promise<void> {
    if (experience === this.settings.experience) return;
    this.settings.experience = experience;
    await this.saveSettings();
    // Adds or removes the Multi-agent-only hooks. Claude Code reads hooks
    // when a session starts, so sessions already running keep the set they
    // started with.
    await this.provisionHooks();
    await this.swapReviewView();
    if (this.experience === "multi-agent") {
      await this.startMultiAgentViews();
    } else {
      for (const leaf of this.leavesOfType(TERMINUS_SIDEBAR_VIEW_TYPE)) leaf.detach();
    }
    // Group colours and hidden tabs apply only in Multi-agent.
    for (const view of this.groups.terminals()) view.refreshGroupColor();
    this.applyGroupVisibility();
  }

  /**
   * Multi-agent's left sidebar, with every terminal loaded so its group is
   * known, and the version check that the sidebar's header shows.
   *
   * Empty groups aren't tidied here: when the plugin is enabled, Obsidian
   * re-creates Terminus's views only after this runs, so every group would
   * look empty (seen in 1.14.4). A group emptied while Classic was selected
   * stays, shown as having no terminals, until its × removes it.
   */
  private async startMultiAgentViews(): Promise<void> {
    await this.groups.loadDeferredTerminals();
    this.groupStore.pruneTabs(this.liveLeafIds());
    this.applyGroupVisibility();
    for (const view of this.groups.terminals()) view.refreshGroupColor();
    await this.revealSidebar(false);
    void this.checkPluginVersion();
  }

  /** Opens the Terminus sidebar in the left sidebar if it isn't open. */
  async revealSidebar(focus = true): Promise<TerminusSidebarView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = this.singleLeafOfType(TERMINUS_SIDEBAR_VIEW_TYPE);
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: TERMINUS_SIDEBAR_VIEW_TYPE, active: focus });
    }
    if (focus) await workspace.revealLeaf(leaf);
    return leaf.view instanceof TerminusSidebarView ? leaf.view : null;
  }

  pluginVersionStatus(): PluginVersionStatus {
    return versionStatus(this.manifest.version, this.latestPluginVersion);
  }

  /** One request to GitHub's releases API (the README's "Network use").
   *  Only when "Check for updates" is on (off by default) and in
   *  Multi-agent, whose sidebar is the only place it shows. A failed check
   *  keeps the last result. */
  private async checkPluginVersion(): Promise<void> {
    if (this.experience !== "multi-agent" || !this.settings.multiAgent.checkForUpdates) return;
    const latest = await fetchLatestPluginVersion();
    if (latest && latest !== this.latestPluginVersion) {
      this.latestPluginVersion = latest;
      this.refreshTerminusViews();
    }
  }

  /** Shows the selected group's tabs and hides other groups' (or, outside
   *  Multi-agent, shows everything), and updates the status bar. */
  applyGroupVisibility(): void {
    this.tabs.apply();
    this.refreshGroupStatus();
  }

  /** "⧉ Auth rotation · 4 in other groups" in the status bar; click to
   *  switch. Empty outside Multi-agent or with no groups. */
  private refreshGroupStatus(): void {
    const el = this.groupStatusEl;
    if (!el) return;
    const groups = this.experience === "multi-agent" ? this.groupStore.list() : [];
    el.toggle(groups.length > 0);
    if (groups.length === 0) return;
    const active = this.groupStore.get(this.groupStore.activeGroupId);
    const hidden = this.tabs.hiddenTerminalCount();
    el.setText(`⧉ ${active?.name ?? "No group"}${hidden > 0 ? ` · ${hidden} in other groups` : ""}`);
    el.setAttr("aria-label", "Switch group");
  }

  /**
   * Puts a non-terminal tab in a group (null: back in every group). With
   * `stay` false the tab came from a group's terminal or card, so that
   * group is selected and the tab the user just opened stays in view.
   */
  addTabToGroup(leaf: WorkspaceLeaf, groupId: string | null, stay = false): void {
    if (this.experience !== "multi-agent") return;
    const leafId = (leaf as WorkspaceLeaf & { id?: string }).id;
    if (!leafId || (!groupId && !stay)) return;
    this.groupStore.setTabGroup(leafId, groupId);
    if (!stay) this.revealGroupOf(leaf);
  }

  /** Selects the group a tab belongs to, if it's another one. */
  revealGroupOf(leaf: WorkspaceLeaf): void {
    if (this.experience !== "multi-agent") return;
    const group = this.tabs.groupOf(leaf);
    if (group && group !== this.groupStore.activeGroupId) this.groupStore.setActive(group);
    else this.applyGroupVisibility();
  }

  /** "Add to group" / "Show in every group" for a tab's right-click menu. */
  addGroupMenuItems(menu: Menu, leaf: WorkspaceLeaf): void {
    if (this.experience !== "multi-agent") return;
    const leafId = (leaf as WorkspaceLeaf & { id?: string }).id;
    if (!leafId) return;
    const current = this.groupStore.tabGroup(leafId);
    menu.addSeparator();
    for (const group of this.groupStore.list()) {
      menu.addItem((item) =>
        item
          .setTitle(`Add to ${group.name}`)
          .setIcon("folder-plus")
          .setChecked(current === group.id)
          .onClick(() => this.addTabToGroup(leaf, group.id, true))
      );
    }
    if (current) {
      menu.addItem((item) =>
        item
          .setTitle("Show in every group")
          .setIcon("folder-minus")
          .onClick(() => this.addTabToGroup(leaf, null, true))
      );
    }
  }

  private liveLeafIds(): Set<string> {
    const ids = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const id = (leaf as WorkspaceLeaf & { id?: string }).id;
      if (id) ids.add(id);
    });
    return ids;
  }

  /** Turning it on checks at once; turning it off forgets the result, so
   *  the sidebar goes back to the plain version. */
  async setCheckForUpdates(check: boolean): Promise<void> {
    this.settings.multiAgent.checkForUpdates = check;
    await this.saveSettings();
    if (check) {
      await this.checkPluginVersion();
    } else {
      this.latestPluginVersion = null;
      this.refreshTerminusViews();
    }
  }

  setGroupColor(groupId: string, color: string): void {
    this.groupStore.setColor(groupId, color);
    for (const view of this.groups.terminalsIn(groupId)) view.refreshGroupColor();
  }

  /** A terminal's tab closed. A group it emptied is removed -- except while
   *  Terminus itself is unloading, when every view closes at once. */
  onTerminalClosed(): void {
    if (this.unloading || this.experience !== "multi-agent") return;
    // After the leaf has left the workspace.
    window.setTimeout(() => {
      if (!this.unloading) this.groups.removeEmptyGroups();
    }, 0);
  }

  /** Each experience has its own review view: closes the other one's
   *  leaves and opens this one's in their place, so the sidebar shows the
   *  view the experience calls for. Pending changes live in the store, so
   *  nothing is lost either way. */
  private async swapReviewView(): Promise<void> {
    const stale = this.experience === "multi-agent" ? PENDING_CHANGES_VIEW_TYPE : AGENT_INBOX_VIEW_TYPE;
    const [first, ...rest] = this.leavesOfType(stale);
    if (!first) return;
    for (const leaf of rest) leaf.detach();
    // Reuses the leaf so the new view lands where the old one was.
    await first.setViewState({ type: this.reviewViewType, active: false });
  }

  /** Writes this experience's hooks into the vault's
   *  .claude/settings.local.json; see provisionClaudeSettings. */
  private async provisionHooks(): Promise<void> {
    try {
      await provisionClaudeSettings(this.app, this.manifest, { experience: this.experience, trackSubagents: this.tracksSubagents });
    } catch (err) {
      console.error("Terminus: failed to provision .claude/settings.local.json", err);
      new Notice(
        "Terminus: could not write .claude/settings.local.json -- diff review won't be wired up for claude. See console."
      );
    }
  }

  /** The active mode's auto-reveal settings: Classic reveals Pending
   *  Changes, Multi-agent the Agent inbox. */
  private autoRevealSettings(): { enabled: boolean; delayMs: number } {
    if (this.experience === "multi-agent") {
      const { autoRevealInbox, autoRevealDelayMs } = this.settings.multiAgent;
      return { enabled: autoRevealInbox, delayMs: autoRevealDelayMs };
    }
    const { autoRevealPendingChanges, autoRevealDelayMs } = this.settings.classic;
    return { enabled: autoRevealPendingChanges, delayMs: autoRevealDelayMs };
  }

  /** True the first time pending changes come from two different terminals
   *  at once while in Classic: the moment Multi-agent's per-session inbox
   *  helps. Counted by terminal token, so a renamed terminal is still one. */
  private shouldInviteToMultiAgent(): boolean {
    if (!MULTI_AGENT_AVAILABLE || this.settings.hasSeenMultiAgentInvite || this.experience !== "classic") return false;
    const tokens = new Set(this.pendingChangesStore.list().flatMap((c) => c.contributors.map((x) => x.token)));
    return tokens.size > 1;
  }

  /** Persisted before the modal opens, like showWelcomeIfFirstRun, so a
   *  crash while it's on screen can't make it come back. */
  private async showMultiAgentInvite(): Promise<void> {
    this.settings.hasSeenMultiAgentInvite = true;
    await this.saveSettings();
    if (await MultiAgentInviteModal.ask(this.app)) {
      await this.setExperience("multi-agent");
      new Notice("Terminus: switched to the Multi-agent experience. Change it any time in settings.");
    }
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
   *  all buttons (see changeRows.ts's runBulkAction) -- these command-
   *  palette/hotkey entries are just as consequential, so they shouldn't
   *  bypass the setting just because they're triggered a different way. */
  private async runBulkPendingChangesCommand(accepted: boolean): Promise<void> {
    const changes = this.pendingChangesStore.list();
    const count = changes.length;
    if (count === 0) {
      new Notice("Terminus: no pending changes");
      return;
    }
    if (!accepted && changes.some(hasCollision)) {
      if (!(await confirmCollisionReject(this.app, changes))) return;
    } else if (this.settings.confirmBulkActions) {
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
    if (!accepted && !(await confirmCollisionReject(this.app, [oldest]))) return;
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

  /**
   * Every leaf of a view type, including ones Obsidian hasn't loaded yet
   * (background sidebar tabs restored at startup), which getLeavesOfType
   * leaves out -- missing those made each startup open another copy of
   * the sidebar views. Compares the view's type rather than calling
   * getViewState(), which on a terminal serializes its whole scrollback.
   */
  leavesOfType(type: string): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === type) leaves.push(leaf);
    });
    return leaves;
  }

  /** Called by each sidebar view as it opens: when the plugin is enabled
   *  (or updated), Obsidian restores its views only after onload, so the
   *  startup reveal can't see them and opens another; this closes it. */
  dedupeView(type: string): void {
    window.setTimeout(() => this.singleLeafOfType(type), 0);
  }

  /** The one leaf of a sidebar view type, closing any duplicates. */
  private singleLeafOfType(type: string): WorkspaceLeaf | null {
    const [first, ...duplicates] = this.leavesOfType(type);
    for (const leaf of duplicates) leaf.detach();
    return first ?? null;
  }

  /** Pending Changes in Classic, the Agent inbox in Multi-agent. */
  private get reviewViewType(): string {
    return this.experience === "multi-agent" ? AGENT_INBOX_VIEW_TYPE : PENDING_CHANGES_VIEW_TYPE;
  }

  /** Reveals the active experience's review view, opening it in the right
   *  sidebar if it isn't open. */
  async revealReviewView(): Promise<void> {
    const { workspace } = this.app;
    const type = this.reviewViewType;
    let leaf: WorkspaceLeaf | null = this.singleLeafOfType(type);
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await leaf.setViewState({ type, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /**
   * Re-reads a session's usage from its transcripts: the lead's, and each
   * subagent's that's running or hasn't had a read since it ended. Called
   * from TerminalView on the hooks that mark progress (prompt, Stop,
   * SubagentStop, StopFailure, SessionStart); nothing polls. Multi-agent
   * only, since only the inbox shows usage.
   */
  async refreshUsage(token: string): Promise<void> {
    if (this.experience !== "multi-agent") return;
    const store = this.agentSessionStore;
    const leadPath = store.get(token)?.transcriptPath;
    if (!leadPath) return;
    try {
      store.usageRead(token, await this.transcriptUsage.read(leadPath, "lead"));
      for (const run of store.get(token)?.subagents ?? []) {
        const key = `${token}:${run.agentId}`;
        if (this.finalSubagentUsage.has(key)) continue;
        const path = run.transcriptPath ?? subagentTranscriptPath(leadPath, run.agentId);
        if (!path) continue;
        store.subagentUsageRead(token, run.agentId, await this.transcriptUsage.read(path, "subagent"));
        if (!run.running) {
          this.finalSubagentUsage.add(key);
          this.transcriptUsage.forget(path);
        }
      }
    } catch (err) {
      // Usage is a nicety: a transcript that can't be read just leaves the
      // last numbers showing.
      console.error("Terminus: could not read Claude's transcript usage", err);
    }
  }

  /**
   * Whether a session's queued feedback can be typed into its terminal now,
   * and if not, why. Only between turns: mid-turn the text would land in
   * Claude's input while it works, and with a prompt open it would answer
   * the prompt.
   */
  feedbackReadiness(token: string): { ready: true } | { ready: false; reason: string } {
    const session = this.agentSessionStore.get(token);
    if (!session?.running || !this.findTerminalView(token)) return { ready: false, reason: "Session ended" };
    if (session.status === "working") return { ready: false, reason: "Available once this turn ends" };
    if (session.status === "needs-attention" && session.needs !== "unread-turn") {
      return { ready: false, reason: "Answer Claude's prompt first" };
    }
    return { ready: true };
  }

  /** Types a session's queued feedback into its terminal, unsubmitted, and
   *  clears the queue: the text is the user's to edit or send from here. */
  async sendFeedback(token: string): Promise<void> {
    const items = this.feedbackStore.listFor(token);
    const terminal = this.findTerminalView(token);
    if (items.length === 0 || !terminal || !this.feedbackReadiness(token).ready) return;
    const base = this.getVaultBasePath();
    const prompt = composeFeedbackPrompt(items, (absolute) => {
      const relative = pathRelative(base, absolute);
      return relative.startsWith("..") ? absolute : relative;
    });
    if (!terminal.typeIntoInput(prompt)) return;
    this.feedbackStore.clear(token);
    await this.focusTerminal(token);
    new Notice(`Terminus: feedback added to ${terminal.getDisplayText()} — press Enter to send it`);
  }

  /** Re-renders open Agent inboxes and Terminus sidebars for changes the
   *  stores don't see, such as a terminal being renamed or recoloured. */
  refreshTerminusViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(AGENT_INBOX_VIEW_TYPE)) {
      if (leaf.view instanceof AgentInboxView) leaf.view.render();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(TERMINUS_SIDEBAR_VIEW_TYPE)) {
      if (leaf.view instanceof TerminusSidebarView) leaf.view.render();
    }
  }

  /** The command's version of a group's ×: asks first only when a session
   *  in it is mid-turn or waiting on an answer. */
  private async closeGroupAsking(groupId: string): Promise<void> {
    const group = this.groupStore.get(groupId);
    if (!group) return;
    if (this.groups.busy(this.groups.terminalsIn(groupId)).length > 0) {
      const ok = await ConfirmModal.confirm(this.app, `Close ${group.name}?`, "Claude is mid-turn here. Close anyway?", "Close");
      if (!ok) return;
    }
    this.groups.closeGroup(groupId);
  }

  findTerminalView(token: string): TerminalView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(TERMINUS_VIEW_TYPE)) {
      if (leaf.view instanceof TerminalView && leaf.view.hookToken === token) return leaf.view;
    }
    return null;
  }

  /** Brings a terminal to the front and gives it the keyboard (its own
   *  active-leaf-change handler focuses xterm and marks the session seen). */
  async focusTerminal(token: string): Promise<void> {
    const view = this.findTerminalView(token);
    if (!view) return;
    await this.app.workspace.revealLeaf(view.leaf);
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
  }

  /** Cycles through running sessions that need you, in inbox order,
   *  starting after the terminal that's active now. */
  async jumpToNextSessionNeedingAttention(): Promise<void> {
    const waiting = this.agentSessionStore
      .list()
      .filter((s) => s.running && s.status === "needs-attention" && this.findTerminalView(s.token));
    if (waiting.length === 0) {
      new Notice("Terminus: no session needs attention");
      return;
    }
    const active = this.app.workspace.getActiveViewOfType(TerminalView)?.hookToken;
    const index = waiting.findIndex((s) => s.token === active);
    const next = waiting[(index + 1) % waiting.length];
    if (next) await this.focusTerminal(next.token);
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
    for (const placement of TERMINAL_OPEN_PLACEMENTS) {
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
      case "split-down": {
        // Resolve the anchor pane ourselves and split off of it explicitly,
        // rather than trusting `getLeaf("split", direction)` to pick the
        // right one internally (it's just `createLeafBySplit(getMostRecentLeaf(),
        // direction)` under the hood) -- going through it directly fixed the
        // exact same "split down" opening to the side instead of below bug
        // in the Tab Spaces plugin.
        const anchor = workspace.getMostRecentLeaf();
        const direction = placement === "split-right" ? "vertical" : "horizontal";
        leaf = anchor ? workspace.createLeafBySplit(anchor, direction) : workspace.getLeaf("split", direction);
        break;
      }
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
        // Dropped by setState if the group has gone since.
        groupId: entry.groupId ?? undefined,
      },
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}
