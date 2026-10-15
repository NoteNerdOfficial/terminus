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
import { ResumeQueue } from "./groups/ResumeQueue";
import { TERMINAL_COLOR_PALETTE } from "./terminal/colorPalette";
import { fetchLatestPluginVersion, PluginVersionStatus, versionStatus } from "./pluginVersion";
import { PendingChangesStore, ResolvedChange } from "./state/PendingChangesStore";
import { ActionLog } from "./state/ActionLog";
import { AgentSessionStore } from "./state/AgentSessionStore";
import { TranscriptUsageReader, subagentTranscriptPath } from "./claude/transcriptUsage";
import { FeedbackStore } from "./state/FeedbackStore";
import { SteerQueueStore } from "./state/SteerQueueStore";
import { InboxUiState } from "./state/InboxUiState";
import { DelegationStore } from "./state/DelegationStore";
import { DelegateModal } from "./modals/DelegateModal";
import { leafForPlacement, type OpenPlacement } from "./util/leafPlacement";
import { composeFeedbackPrompt } from "./claude/feedbackPrompt";
import { ClosedTerminalBuffer, ClosedTerminalEntry } from "./state/ClosedTerminalBuffer";
import { ActionLogModal } from "./modals/ActionLogModal";
import { ConfirmModal } from "./modals/ConfirmModal";
import { confirmCollisionReject, hasCollision } from "./modals/collisions";
import { RescueClosedTerminalModal } from "./modals/RescueClosedTerminalModal";
import { GettingStartedModal } from "./modals/GettingStartedModal";
import { MultiAgentInviteModal } from "./modals/MultiAgentInviteModal";
import { WhatsNewModal } from "./modals/WhatsNewModal";
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
  TERMINAL_PLACEMENT_LABELS,
  TERMINAL_OPEN_PLACEMENTS,
  CursorStyle,
} from "./settings";

/** A burst smaller than both of these doesn't pull an open inbox to front. */
const AUTO_REVEAL_MIN_FILES = 3;
const AUTO_REVEAL_MIN_LINES = 50;

export default class TerminusPlugin extends Plugin {
  readonly reviewServer = new ReviewServer();
  readonly pendingChangesStore = new PendingChangesStore();
  /** Each terminal's Claude session status, for the Agent inbox. */
  readonly agentSessionStore = new AgentSessionStore();
  /** Review comments queued per session (Multi-agent only). */
  readonly feedbackStore = new FeedbackStore();
  /** Messages queued per session, sent one per turn end (Multi-agent only). */
  readonly steerQueue = new SteerQueueStore();
  /** Sessions whose queued message was just sent and hasn't started its turn
   *  yet, so the next one waits for that turn to end. */
  private readonly queueSendPending = new Map<string, number>();
  /** Tasks sent from a session to a new terminal (Multi-agent only). */
  readonly delegationStore = new DelegationStore();
  /** Spaces out Claude sessions resumed after a restart (Multi-agent only). */
  readonly resumeQueue = new ResumeQueue();
  /** How the user has arranged the Agent inbox; outlives the view. */
  readonly inboxUi = new InboxUiState();
  /** Files of the current burst of edits, for the auto-reveal's threshold. */
  private revealBurst = new Set<string>();
  /** The inbox's user-action revision when the current burst began. */
  private revealBurstRevision = 0;
  /** Multi-agent's terminal groups; created once settings are loaded. */
  groupStore!: GroupStore;
  readonly groups = new GroupController(this);
  /** Latest release on GitHub, once checked (Multi-agent only). */
  private latestPluginVersion: string | null = null;
  /** Set first thing in onunload: views closing then aren't the user
   *  closing terminals, so groups mustn't be tidied away. */
  private unloading = false;

  get isUnloading(): boolean {
    return this.unloading;
  }
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
  /** No saved settings existed when this load began. */
  private freshInstall = false;
  /** This load moved the install to Multi-agent: the notice is still owed. */
  private defaultNoticePending = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.defaultNoticePending = await this.applyMultiAgentDefault();
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
    // Each terminal saves its queue in its own state, so a change asks
    // Obsidian to write the layout; a session's turn ending sends the next.
    this.steerQueue.on("change", () => {
      this.app.workspace.requestSaveLayout();
      for (const token of this.steerQueue.tokens()) this.drainSteerQueue(token);
    });
    this.agentSessionStore.on("change", (session) => {
      if (session.status === "working") this.clearQueueSendPending(session.token);
      this.drainSteerQueue(session.token);
    });
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
    this.pendingChangesStore.on("recorded", (change) => {
      const reveal = this.autoRevealSettings();
      if (!reveal.enabled && !this.shouldInviteToMultiAgent()) return;
      // A burst starts with its first edit: note the inbox's revision then,
      // so a choice the user makes while the burst settles can veto the reveal.
      if (this.revealPendingChangesTimer === null) {
        this.revealBurst.clear();
        this.revealBurstRevision = this.inboxUi.userActionRevision;
      } else {
        window.clearTimeout(this.revealPendingChangesTimer);
      }
      this.revealBurst.add(change.id);
      this.revealPendingChangesTimer = window.setTimeout(() => {
        this.revealPendingChangesTimer = null;
        if (reveal.enabled && this.shouldAutoReveal()) void this.revealReviewView();
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
    this.groups.register();

    // Twice a day, while the sidebar that shows it is in use.
    this.registerInterval(window.setInterval(() => void this.checkPluginVersion(), 12 * 60 * 60 * 1000));

    this.ribbonIconEl = this.addRibbonIcon(this.settings.ribbonIcon, "Open Terminus", (evt) => {
      this.openTerminal(evt);
    });

    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => this.openTerminal(),
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
      void this.showWelcomeIfFirstRun().then((showedWelcome) => {
        // The welcome already says Multi-agent is the default, so an install
        // that sees it doesn't get a second modal on top.
        if (this.defaultNoticePending && !showedWelcome) this.announceMultiAgentDefault();
      });
      if (this.experience === "multi-agent") void this.startMultiAgentViews();
    });
  }

  /** Fires at most once per install. The flag is persisted before the modal
   *  opens rather than after it's dismissed, so a crash or a force-quit
   *  while it's on screen can't turn it into a modal that greets the user
   *  on every single startup. */
  private async showWelcomeIfFirstRun(): Promise<boolean> {
    if (this.settings.hasSeenWelcome) return false;
    this.settings.hasSeenWelcome = true;
    await this.saveSettings();
    GettingStartedModal.openWelcome(this.app);
    return true;
  }

  onunload(): void {
    this.unloading = true;
    this.resumeQueue.dispose();
    for (const timer of this.queueSendPending.values()) window.clearTimeout(timer);
    this.queueSendPending.clear();
    if (this.revealPendingChangesTimer) window.clearTimeout(this.revealPendingChangesTimer);
    void this.reviewServer.stop();
  }

  async loadSettings(): Promise<void> {
    const saved: unknown = await this.loadData();
    this.freshInstall = saved === null || saved === undefined;
    this.settings = resolveSettings(saved);
  }

  /**
   * Multi-agent is the default. A new install starts in it. An existing
   * install that never chose (it hasn't seen the invite to try it, so it was
   * only ever on Classic by default) is moved to it once, and told how to go
   * back; one that dismissed the invite or switched itself keeps what it has.
   * Runs before anything reads `experience`, so hooks and views start in the
   * right mode. Returns whether the notice should be shown.
   */
  private async applyMultiAgentDefault(): Promise<boolean> {
    if (!MULTI_AGENT_AVAILABLE || this.settings.hasSeenMultiAgentDefault) return false;
    this.settings.hasSeenMultiAgentDefault = true;
    let moved = false;
    if (this.freshInstall) {
      // Nothing to invite them to: they're already in it.
      this.settings.hasSeenMultiAgentInvite = true;
    } else if (this.settings.experience === "classic" && !this.settings.hasSeenMultiAgentInvite) {
      this.settings.experience = "multi-agent";
      this.settings.hasSeenMultiAgentInvite = true;
      moved = true;
    }
    await this.saveSettings();
    return moved;
  }

  /** The one-time "What's new" popup for an install moved to Multi-agent, a
   *  few seconds after the workspace is up so it doesn't land on a half-
   *  loaded window. "Switch to Classic" is the way back without opening
   *  settings; "Read the guide" opens the guide at the Multi-agent section. */
  private announceMultiAgentDefault(): void {
    window.setTimeout(() => {
      if (this.isUnloading) return;
      void WhatsNewModal.ask(this.app).then(async (choice) => {
        if (choice === "guide") {
          GettingStartedModal.openGuide(this.app, "Multi-agent");
        } else if (choice === "classic") {
          await this.setExperience("classic");
          new Notice("Terminus: switched to the Classic experience. Change it any time in settings.");
        }
      });
    }, 3000);
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
    // Choosing Classic is a decision: don't invite them back to Multi-agent.
    if (experience === "classic") this.settings.hasSeenMultiAgentInvite = true;
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
    this.groups.applyVisibility();
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
    await this.groups.start();
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

  /**
   * Whether the burst that just settled should bring the review view to
   * front. Classic always does. In Multi-agent the user's own choices win:
   * not if they closed or rearranged the inbox since the burst began, and,
   * when the inbox is already open, not for a trivial burst (under
   * AUTO_REVEAL_MIN_FILES files and AUTO_REVEAL_MIN_LINES changed lines).
   * An inbox that isn't open yet is opened regardless, so it can be found.
   */
  private shouldAutoReveal(): boolean {
    if (this.experience !== "multi-agent") return true;
    if (this.inboxUi.userActionRevision !== this.revealBurstRevision) return false;
    if (!this.singleLeafOfType(AGENT_INBOX_VIEW_TYPE)) return true;
    if (this.revealBurst.size >= AUTO_REVEAL_MIN_FILES) return true;
    let lines = 0;
    for (const change of this.pendingChangesStore.list()) {
      if (!this.revealBurst.has(change.id)) continue;
      const stats = computeDiffStats(change.diff);
      lines += stats.added + stats.removed;
    }
    return lines >= AUTO_REVEAL_MIN_LINES;
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
    if (this.claudeBin) return this.claudeBin;
    const resolved = await resolveClaudeBin();
    // The bare name means nothing was found; don't remember that, so a
    // later install or a faster shell startup gets picked up.
    if (resolved !== "claude") this.claudeBin = resolved;
    return resolved;
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

  /** Shows the inbox with one session's card in view and unfolded, as when
   *  the sidebar's "to review" count on its terminal is clicked. Selects the
   *  terminal's group first (without taking the keyboard), since the inbox
   *  follows it. */
  async revealInboxCard(token: string): Promise<void> {
    const groupId = this.findTerminalView(token)?.groupId ?? null;
    if (groupId && this.groupStore.get(groupId) && groupId !== this.groupStore.activeGroupId) {
      await this.groups.selectGroup(groupId, false);
    }
    this.inboxUi.userAction();
    this.inboxUi.collapsedCards.delete(token);
    this.inboxUi.revealToken = token;
    await this.revealReviewView();
    this.refreshTerminusViews();
  }

  /** Shows the inbox for a group, as when its "to review" summary is clicked. */
  async revealInboxGroup(groupId: string): Promise<void> {
    if (groupId !== this.groupStore.activeGroupId) await this.groups.selectGroup(groupId, false);
    this.inboxUi.userAction();
    await this.revealReviewView();
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

  /**
   * "Send to a new terminal": asks for a prompt, then opens a new Claude
   * terminal beside the sender, in the folder its session runs in, with the
   * prompt typed in (never submitted) and the task listed on the sender's
   * card until its result comes back.
   */
  async sendToNewTerminal(from: TerminalView): Promise<void> {
    const session = this.agentSessionStore.get(from.hookToken);
    if (!session?.running) return;
    const group = this.groupStore.get(from.groupId);
    const task = await DelegateModal.prompt(this.app, from.getDisplayText(), group?.name ?? null);
    if (!task) return;
    const title = task.replace(/\s+/g, " ").slice(0, 32);
    const child = await this.groups.newTerminal(from.groupId, true, {
      command: "claude",
      prompt: task,
      cwd: session.cwd ?? undefined,
      name: `${from.getDisplayText()} › ${title}${task.length > 32 ? "…" : ""}`,
    });
    if (!child) return;
    this.delegationStore.add({
      childToken: child.hookToken,
      parentToken: from.hookToken,
      task,
      parentLabel: from.getDisplayText(),
      childLabel: child.getDisplayText(),
      createdAt: Date.now(),
    });
  }

  /** Types a delegated session's result into the sending session's input
   *  line (unsubmitted, like feedback) and takes the task off the card. */
  async sendDelegationResult(childToken: string): Promise<void> {
    const delegation = this.delegationStore.get(childToken);
    const result = this.agentSessionStore.get(childToken)?.lastMessage;
    const parent = delegation ? this.findTerminalView(delegation.parentToken) : null;
    if (!delegation || !result || !parent || !this.feedbackReadiness(delegation.parentToken).ready) return;
    const childName = this.findTerminalView(childToken)?.getDisplayText() ?? delegation.childLabel;
    if (!parent.typeIntoInput(`The result from ${childName} (I asked it: ${delegation.task.replace(/\s+/g, " ")}):\n\n${result}`)) return;
    this.delegationStore.remove(childToken);
    await this.focusTerminal(delegation.parentToken);
    new Notice(`Terminus: result added to ${parent.getDisplayText()} — press Enter to send it`);
  }

  /**
   * Whether guidance can be typed into a session now. Unlike review
   * feedback it is allowed mid-turn: Claude queues what's entered then and
   * folds it into the running turn, which is the point. It's refused while
   * Claude waits on a prompt (permission or a question), where typed text
   * could answer it.
   */
  steerReadiness(token: string): { ready: true } | { ready: false; reason: string } {
    const session = this.agentSessionStore.get(token);
    if (!session?.running || !this.findTerminalView(token)) return { ready: false, reason: "Session ended" };
    if (session.status === "needs-attention" && session.needs !== "unread-turn") {
      return { ready: false, reason: "Answer Claude's prompt first" };
    }
    return { ready: true };
  }

  /**
   * "Tell this session…": types the text into the session's input line.
   * `submit` is the user's explicit "Send now": Enter follows shortly after,
   * so the TUI has taken the text first, and the terminal is left alone so
   * several can be sent from the inbox. Otherwise the terminal is focused
   * and the Enter is the user's. False when it couldn't be typed.
   */
  async sendGuidance(token: string, text: string, submit: boolean): Promise<boolean> {
    const terminal = this.findTerminalView(token);
    const message = text.trim();
    if (!terminal || !message || !this.steerReadiness(token).ready) return false;
    if (!terminal.typeIntoInput(message)) return false;
    if (submit) {
      window.setTimeout(() => terminal.submitInput(), 250);
      new Notice(`Terminus: sent to ${terminal.getDisplayText()}`);
    } else {
      await this.focusTerminal(token);
      new Notice(`Terminus: added to ${terminal.getDisplayText()} — press Enter to send it`);
    }
    return true;
  }

  /**
   * "Queue": holds the text until the session's turn ends, then sends it,
   * one message per turn. Between turns it goes at once. Allowed while
   * Claude waits on a prompt (it's only held then), so only a running
   * session with a terminal is required.
   */
  queueGuidance(token: string, text: string): boolean {
    const session = this.agentSessionStore.get(token);
    if (!session?.running || !this.findTerminalView(token)) return false;
    if (!this.steerQueue.add(token, text)) return false;
    // Queueing is the user's own call on this session: it un-pauses a queue
    // restored after a restart.
    this.steerQueue.resume(token);
    return true;
  }

  /** "Steer" on a queued message: sends it into the running turn now. */
  async steerQueued(token: string, id: number): Promise<boolean> {
    const item = this.steerQueue.listFor(token).find((queued) => queued.id === id);
    if (!item || !(await this.sendGuidance(token, item.text, true))) return false;
    this.steerQueue.remove(token, id);
    return true;
  }

  /** Why a session's queue isn't sending on its own right now, or null. */
  queueHoldReason(token: string): string | null {
    if (this.steerQueue.listFor(token).length === 0) return null;
    if (this.steerQueue.isPaused(token)) return "Paused after a restart";
    const session = this.agentSessionStore.get(token);
    if (!session?.running || !this.findTerminalView(token)) return "Session ended";
    if (session.status === "needs-attention" && session.needs !== "unread-turn") return "Waiting for Claude's prompt";
    if (session.lastTurnFailed) return "Paused: the last turn failed";
    return null;
  }

  private clearQueueSendPending(token: string): void {
    const timer = this.queueSendPending.get(token);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.queueSendPending.delete(token);
  }

  /** Sends a session's next queued message if it's between turns and
   *  nothing holds the queue (see queueHoldReason). */
  private drainSteerQueue(token: string): void {
    const next = this.steerQueue.listFor(token)[0];
    const session = this.agentSessionStore.get(token);
    const terminal = this.findTerminalView(token);
    if (!next || !session || !terminal || session.status === "working") return;
    if (this.queueSendPending.has(token) || this.queueHoldReason(token)) return;
    if (!terminal.typeIntoInput(next.text)) return;
    // The turn starts a moment after Enter; until it does, the session still
    // reads as idle and must not send the next message on top of this one.
    // Set before the shift below, which re-enters this method via "change".
    this.queueSendPending.set(
      token,
      window.setTimeout(() => this.queueSendPending.delete(token), 8000)
    );
    this.steerQueue.shift(token);
    window.setTimeout(() => terminal.submitInput(), 250);
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

  /** Calls `onPick` with the placement for a new terminal: the setting, or,
   *  when it's "Always ask", the user's pick from a menu at `evt` (nothing
   *  happens if they dismiss it). Ribbon clicks always carry a MouseEvent to
   *  anchor the menu to; a command-palette/hotkey invocation doesn't, so
   *  "Always ask" falls back to a plain new tab there rather than showing a
   *  menu with no sensible place to appear. `allowWindow` false is for
   *  terminals that belong to a group, whose tabs are shown and hidden with
   *  it: a new window then becomes a tab. */
  choosePlacement(evt: MouseEvent | undefined, onPick: (placement: OpenPlacement) => void, allowWindow = true): void {
    const setting = this.settings.terminalPlacement;
    const allowed = TERMINAL_OPEN_PLACEMENTS.filter((p) => allowWindow || p !== "window");
    if (setting !== "ask") onPick(allowed.includes(setting) ? setting : "tab");
    else if (evt) this.askPlacement(evt, onPick, allowed);
    else onPick("tab");
  }

  /** The placement menu, anchored at `evt`. A callback rather than a
   *  promise: Obsidian hides the menu before it runs an item's click, so
   *  "dismissed" can't be told apart from "picked" by the hide event. */
  private askPlacement(evt: MouseEvent, onPick: (placement: OpenPlacement) => void, allowed: OpenPlacement[] = TERMINAL_OPEN_PLACEMENTS): void {
    const menu = new Menu();
    for (const placement of allowed) {
      menu.addItem((item) => item.setTitle(TERMINAL_PLACEMENT_LABELS[placement]).onClick(() => onPick(placement)));
    }
    menu.showAtMouseEvent(evt);
  }

  private openTerminal(evt?: MouseEvent): void {
    this.choosePlacement(evt, (placement) => void this.openTerminalAt(placement));
  }

  /** Always opens a NEW terminal -- multiple concurrent terminals (each
   *  running their own `claude` session) are supported; the hook/review
   *  plumbing already keys everything by each TerminalView's own random
   *  token, so this was purely a UI limitation (this used to dedupe against
   *  an existing terminal leaf). Reusing an existing terminal is just
   *  normal Obsidian tab-switching, not this command's job. */
  private async openTerminalAt(placement: OpenPlacement): Promise<void> {
    const { workspace } = this.app;
    const leaf = leafForPlacement(workspace, placement);
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
