import { setIcon, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { TERMINUS_VIEW_TYPE, TerminalView } from "../views/TerminalView";
import { DIFF_SPLIT_VIEW_TYPE } from "../views/DiffSplitView";
import { isOpenGroup, type TerminalGroup } from "../state/GroupStore";
import { ConfirmModal } from "../modals/ConfirmModal";
import { TabVisibility } from "./TabVisibility";
import { GroupSuggestModal } from "./GroupSuggestModal";
import { TerminalSwitcherModal } from "./TerminalSwitcherModal";
import { forkCommand } from "./forkSession";
import { addNoteMenuItems, moveTabCommand } from "./groupMenus";
import { noteFile, noteStatus, startClaudeOnNote } from "./groupNotes";
import { leafForPlacement, type OpenPlacement } from "../util/leafPlacement";
import type TerminusPlugin from "../main";

/** Ungrouped, or a group id. */
export type GroupTarget = string | null;

/**
 * The Multi-agent experience's groups, applied to the workspace, all in one
 * place: which terminals and tabs are in which group, creating, moving and
 * closing, which tabs show, the status bar, linked notes' suggestions, and
 * the events, commands and menus behind them (register()). Group data lives
 * in GroupStore; a terminal's membership lives on its TerminalView.
 * Event-driven only: never reads a terminal's view state (getState()
 * serializes its whole scrollback).
 */
export class GroupController {
  readonly tabs: TabVisibility;
  /** Group id → a suggested status for its note, shown in the sidebar
   *  until acted on or dismissed (see suggestNoteStatus). */
  readonly noteSuggestions = new Map<string, "review" | "active">();
  /** Each session's last status, to spot a turn starting or ending. */
  private lastSessionStatus = new Map<string, string>();
  private statusEl: HTMLElement | null = null;

  constructor(private readonly plugin: TerminusPlugin) {
    this.tabs = new TabVisibility(plugin);
  }

  private get multiAgent(): boolean {
    return this.plugin.experience === "multi-agent";
  }

  /** Called once from onload, after the stores exist. */
  register(): void {
    const { plugin } = this;
    const { workspace, vault, metadataCache } = plugin.app;

    // Opening a terminal from another group switches to that group.
    plugin.registerEvent(
      workspace.on("active-leaf-change", (leaf) => {
        if (this.multiAgent) this.onActiveLeaf(leaf);
      })
    );
    // New, moved and closed tabs: re-apply which tabs show. Also where
    // terminals restored after startup get loaded (see start()).
    plugin.registerEvent(
      workspace.on("layout-change", () => {
        if (this.multiAgent) void this.loadDeferredTerminals();
        this.applyVisibility();
      })
    );
    this.store.on("change", () => this.applyVisibility());
    // A note's menu (file list, tab, ⋯): Start Claude, and on a tab the
    // move items, in one section.
    plugin.registerEvent(
      workspace.on("file-menu", (menu, file, source, leaf) => {
        if (!this.multiAgent || !(file instanceof TFile)) return;
        addNoteMenuItems(menu, plugin, file, source === "tab-header" ? leaf : undefined);
      })
    );
    // Linked notes follow renames; a deleted note unlinks; a status change
    // shows in the sidebar.
    plugin.registerEvent(vault.on("rename", (file: TAbstractFile, oldPath: string) => this.store.noteMoved(oldPath, file.path)));
    plugin.registerEvent(vault.on("delete", (file: TAbstractFile) => this.store.noteMoved(file.path, null)));
    plugin.registerEvent(
      metadataCache.on("changed", (file) => {
        if (this.store.list().some((g) => g.note === file.path)) plugin.refreshTerminusViews();
      })
    );
    plugin.agentSessionStore.on("change", (session) => this.suggestNoteStatus(session.token, session.status));
    plugin.agentSessionStore.on("change", (session) => this.unsettleForSession(session.token));
    plugin.agentSessionStore.on("change", (session) => this.wakeForSession(session.token));
    // A snooze's wake time is a timer, set again whenever the groups change.
    this.store.on("change", () => this.scheduleWake());
    plugin.register(() => this.clearWakeTimer());

    this.statusEl = plugin.addStatusBarItem();
    this.statusEl.addClass("terminus-group-status", "mod-clickable");
    this.statusEl.addEventListener("click", () => this.switchGroupPicker());

    this.registerCommands();
  }

  private registerCommands(): void {
    const { plugin } = this;
    const multiAgent = (check: () => boolean, run: () => void) => (checking: boolean) => {
      if (!this.multiAgent || !check()) return false;
      if (!checking) run();
      return true;
    };
    plugin.addCommand({
      id: "new-group",
      name: "New group",
      checkCallback: multiAgent(
        () => true,
        () => void this.createGroup().then(async (group) => (await plugin.revealSidebar())?.startRename(group.id))
      ),
    });
    plugin.addCommand({
      id: "switch-group",
      name: "Switch group…",
      checkCallback: multiAgent(() => this.store.list().length > 0, () => this.switchGroupPicker()),
    });
    plugin.addCommand({
      id: "go-to-terminal",
      name: "Go to terminal or group…",
      checkCallback: multiAgent(
        () => this.terminals().length > 0 || this.store.list().length > 0,
        () => new TerminalSwitcherModal(plugin).open()
      ),
    });
    plugin.addCommand({
      id: "move-tab-to-group",
      name: "Move tab to group…",
      checkCallback: multiAgent(
        () => !!plugin.app.workspace.getMostRecentLeaf() && this.store.list().length > 0,
        () => {
          const leaf = plugin.app.workspace.getMostRecentLeaf();
          if (leaf) moveTabCommand(plugin, leaf);
        }
      ),
    });
    plugin.addCommand({
      id: "start-claude-on-note",
      name: "Start Claude on this note",
      checkCallback: multiAgent(
        () => plugin.app.workspace.getActiveFile()?.extension === "md",
        () => {
          const file = plugin.app.workspace.getActiveFile();
          if (file) void startClaudeOnNote(plugin, file);
        }
      ),
    });
    plugin.addCommand({
      id: "close-group",
      name: "Close group",
      checkCallback: multiAgent(
        () => !!this.store.activeGroupId,
        () => {
          const groupId = this.store.activeGroupId;
          if (groupId) void this.closeGroupAsking(groupId);
        }
      ),
    });
  }

  /** Multi-agent starting (at load or on switching): every terminal loaded
   *  so its group is known, dead tabs forgotten, and tabs shown or hidden.
   *  Empty groups aren't tidied here; see removeEmptyGroups. */
  async start(): Promise<void> {
    await this.loadDeferredTerminals();
    this.store.pruneTabs(this.liveLeafIds());
    // Snoozes that ran out while Obsidian was closed wake now.
    this.wakeDue();
    this.scheduleWake();
    this.applyVisibility();
  }

  /** Shows the selected group's tabs and hides other groups' (outside
   *  Multi-agent, shows everything), and updates the status bar. */
  applyVisibility(): void {
    this.tabs.apply();
    this.refreshStatus();
  }

  /** "Auth rotation · 4 in other groups", with a layers icon, in the status bar; click to
   *  switch. Empty outside Multi-agent or with no groups. */
  private refreshStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    const groups = this.multiAgent ? this.store.list() : [];
    el.toggle(groups.length > 0);
    if (groups.length === 0) return;
    const active = this.store.get(this.store.activeGroupId);
    const hidden = this.tabs.hiddenTerminalCount();
    el.empty();
    setIcon(el.createSpan({ cls: "terminus-meta-icon" }), "layers");
    el.createSpan({ text: `${active?.name ?? "No group"}${hidden > 0 ? ` · ${hidden} in other groups` : ""}` });
    el.setAttr("aria-label", "Switch group");
  }

  private switchGroupPicker(): void {
    new GroupSuggestModal(this.plugin, "Switch to group", { mode: "switch" }, (choice) => {
      if (choice.kind === "group") void this.selectGroup(choice.target);
    }).open();
  }

  /**
   * Puts a non-terminal tab in a group (null: back in every group). With
   * `stay` false the tab came from a group's terminal or card, so that
   * group is selected and the tab the user just opened stays in view.
   */
  addTabToGroup(leaf: WorkspaceLeaf, groupId: string | null, stay = false): void {
    if (!this.multiAgent) return;
    const leafId = (leaf as WorkspaceLeaf & { id?: string }).id;
    if (!leafId || (!groupId && !stay)) return;
    this.store.setTabGroup(leafId, groupId);
    if (!stay) this.revealGroupOf(leaf);
  }

  /** Selects the group a tab belongs to, if it's another one. */
  revealGroupOf(leaf: WorkspaceLeaf): void {
    if (!this.multiAgent) return;
    const group = this.tabs.groupOf(leaf);
    if (group && group !== this.store.activeGroupId) this.store.setActive(group);
    else this.applyVisibility();
  }

  setGroupColor(groupId: string, color: string): void {
    this.store.setColor(groupId, color);
    for (const view of this.terminalsIn(groupId)) view.refreshGroupColor();
  }

  /** A terminal's tab closed. A group it emptied is removed -- except while
   *  Terminus itself is unloading, when every view closes at once. */
  onTerminalClosed(): void {
    if (this.plugin.isUnloading || !this.multiAgent) return;
    // After the leaf has left the workspace.
    window.setTimeout(() => {
      if (!this.plugin.isUnloading) this.removeEmptyGroups();
    }, 0);
  }

  /** The command's version of a group's ×: asks first only when a session
   *  in it is mid-turn or waiting on an answer. */
  private async closeGroupAsking(groupId: string): Promise<void> {
    const group = this.store.get(groupId);
    if (!group) return;
    if (this.busy(this.terminalsIn(groupId)).length > 0) {
      const ok = await ConfirmModal.confirm(this.plugin.app, `Close ${group.name}?`, "Claude is mid-turn here. Close anyway?", "Close");
      if (!ok) return;
    }
    this.closeGroup(groupId);
  }

  /**
   * Suggests (never makes) a status change for a group's linked note: a
   * turn ending with the note "active" suggests "review"; a new turn with
   * it in "review" suggests "active". Only for those values, so a note
   * whose `status` means something else is left alone, and nothing ever
   * suggests "done". A permission prompt mid-turn isn't a turn ending.
   */
  private suggestNoteStatus(token: string, status: string): void {
    const previous = this.lastSessionStatus.get(token);
    this.lastSessionStatus.set(token, status);
    if (!this.multiAgent || previous === status) return;
    const group = this.store.get(this.plugin.findTerminalView(token)?.groupId);
    const file = noteFile(this.plugin, group?.note ?? null);
    if (!group || !file) return;
    const current = noteStatus(this.plugin, file);
    const turnEnded = previous === "working" && (status === "finished-unread" || status === "idle");
    let suggestion: "review" | "active" | null = null;
    if (turnEnded && current === "active") suggestion = "review";
    else if (previous !== "working" && status === "working" && current === "review") suggestion = "active";
    if (!suggestion || this.noteSuggestions.get(group.id) === suggestion) return;
    this.noteSuggestions.set(group.id, suggestion);
    this.plugin.refreshTerminusViews();
  }

  private liveLeafIds(): Set<string> {
    const ids = new Set<string>();
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const id = (leaf as WorkspaceLeaf & { id?: string }).id;
      if (id) ids.add(id);
    });
    return ids;
  }

  private get store() {
    return this.plugin.groupStore;
  }

  /** Every terminal, in workspace order. Only loaded views: in Multi-agent
   *  every terminal tab is loaded at startup (see loadDeferredTerminals). */
  terminals(): TerminalView[] {
    return this.plugin.app.workspace
      .getLeavesOfType(TERMINUS_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is TerminalView => view instanceof TerminalView);
  }

  terminalsIn(target: GroupTarget): TerminalView[] {
    return this.terminals().filter((view) => view.groupId === target);
  }

  /** The other tabs in a group (notes, mostly: opened from its terminals or
   *  inbox card, or moved there), in workspace order. Its linked note is
   *  left out when given, since the sidebar shows that one in the header;
   *  Split Diff tabs are too, since they follow their change. */
  tabsIn(groupId: string, except?: string | null): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    this.plugin.app.workspace.iterateRootLeaves((leaf) => {
      const id = (leaf as WorkspaceLeaf & { id?: string }).id;
      const type = leaf.view.getViewType();
      if (!id || type === TERMINUS_VIEW_TYPE || type === DIFF_SPLIT_VIEW_TYPE) return;
      if (this.store.tabGroup(id) !== groupId) return;
      const file = (leaf.getViewState().state as { file?: unknown } | undefined)?.file;
      if (except && file === except) return;
      leaves.push(leaf);
    });
    return leaves;
  }

  /** Brings one of a group's tabs forward, switching to its group. */
  async showTab(leaf: WorkspaceLeaf): Promise<void> {
    const groupId = this.tabs.groupOf(leaf);
    if (groupId && groupId !== this.store.activeGroupId) this.store.setActive(groupId);
    await this.plugin.app.workspace.revealLeaf(leaf);
    this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Obsidian defers loading background tabs until they're shown, and a
   *  deferred terminal has no shell and no group yet. Groups are about
   *  terminals running in the background, so all of them are loaded. */
  async loadDeferredTerminals(): Promise<void> {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(TERMINUS_VIEW_TYPE)) {
      const deferred = leaf as WorkspaceLeaf & { isDeferred?: boolean; loadIfDeferred?: () => Promise<void> };
      if (deferred.isDeferred && deferred.loadIfDeferred) await deferred.loadIfDeferred();
    }
  }

  /**
   * A new group. With `terminals`, they move into it; without, it starts
   * with a new terminal, so it starts with something in it. Either way it becomes
   * the selected group. Nothing takes the keyboard: the caller usually puts
   * the group's name into a rename field next.
   */
  async createGroup(terminals: TerminalView[] = []): Promise<TerminalGroup> {
    const group = this.store.create();
    if (terminals.length > 0) {
      this.moveTerminals(terminals, group.id);
    } else {
      await this.newTerminal(group.id, false);
    }
    await this.selectGroup(group.id, false);
    return group;
  }

  /** A new terminal in a group (starting in its folder, next to the
   *  terminal last used there) or ungrouped. */
  async newTerminal(
    target: GroupTarget,
    focus = true,
    launch?: { command: string; prompt?: string; cwd?: string; name?: string },
    placement: OpenPlacement = "tab"
  ): Promise<TerminalView | null> {
    const { workspace } = this.plugin.app;
    const group = this.store.get(target);
    const anchorId = group ? this.store.lastLeaf(group.id) : undefined;
    const anchor = (anchorId && workspace.getLeafById(anchorId)) || this.terminalsIn(target)[0]?.leaf;
    if (anchor) workspace.setActiveLeaf(anchor, { focus: false });
    // A split is made off the anchor just made active, so it lands beside
    // the group's own terminal.
    const leaf = leafForPlacement(workspace, placement);
    await leaf.setViewState({
      type: TERMINUS_VIEW_TYPE,
      active: focus,
      state: { groupId: group?.id, cwd: launch?.cwd ?? group?.folder ?? undefined, customName: launch?.name, launch },
    });
    await workspace.revealLeaf(leaf);
    this.applyVisibility();
    return leaf.view instanceof TerminalView ? leaf.view : null;
  }

  /** Moves terminals into a group or out of all of them, then removes any
   *  group the move left empty. */
  moveTerminals(terminals: TerminalView[], target: GroupTarget): void {
    for (const view of terminals) view.setGroup(target);
    this.removeEmptyGroups();
    // Membership lives on the terminals, so the store may not have changed.
    this.applyVisibility();
    this.plugin.refreshTerminusViews();
  }

  /** Groups with nothing left in them go. One whose last terminal moved
   *  out or closed but that still has notes (open in it, or linked) stays,
   *  showing "No terminals", so reorganising terminals never silently
   *  ungroups the user's notes; its × closes it. */
  removeEmptyGroups(): void {
    const used = new Set(this.terminals().map((view) => view.groupId));
    for (const group of this.store.list()) {
      if (used.has(group.id) || group.note || this.tabsIn(group.id).length > 0) continue;
      this.store.remove(group.id);
    }
  }

  /** Selects a group and brings back the terminal last used in it, giving
   *  it the keyboard unless `focus` is false. */
  async selectGroup(target: GroupTarget, focus = true): Promise<void> {
    this.store.setActive(target);
    if (!target) return;
    const { workspace } = this.plugin.app;
    const lastId = this.store.lastLeaf(target);
    const last = lastId ? workspace.getLeafById(lastId) : null;
    const leaf = last && last.view instanceof TerminalView && last.view.groupId === target ? last : this.terminalsIn(target)[0]?.leaf;
    if (!leaf) return;
    await workspace.revealLeaf(leaf);
    if (focus) workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Opening a terminal from another group (its row, an inbox card, Next,
   *  or plain tab navigation) switches to that group; and the group
   *  remembers it as its last-used terminal. */
  onActiveLeaf(leaf: WorkspaceLeaf | null): void {
    if (!leaf || !(leaf.view instanceof TerminalView)) return;
    const groupId = leaf.view.groupId;
    const leafId = (leaf as WorkspaceLeaf & { id?: string }).id;
    if (groupId && leafId) this.store.setLastLeaf(groupId, leafId);
    if (groupId && groupId !== this.store.activeGroupId) this.store.setActive(groupId);
  }

  /** Closes terminals (their tabs) and removes groups left empty. Asking
   *  first about busy sessions is the caller's job. */
  closeTerminals(terminals: TerminalView[]): void {
    for (const view of terminals) view.leaf.detach();
    this.removeEmptyGroups();
  }

  /** Forks a terminal's Claude session into a new terminal in the same
   *  group: `claude --resume <id> --fork-session`, in the folder the
   *  session ran in (Claude finds a session by its folder). The fork is
   *  named after its source, so the sidebar says where it came from.
   *  False when there's no session to fork. */
  async forkSession(view: TerminalView): Promise<boolean> {
    const session = this.plugin.agentSessionStore.get(view.hookToken);
    const command = forkCommand(session?.sessionId ?? null);
    if (!session || !command) return false;
    await this.newTerminal(view.groupId, true, { command, cwd: session.cwd ?? undefined, name: `${view.getDisplayText()} (fork)` });
    return true;
  }

  /** Settling is refused while a session in the group is mid-turn or
   *  waiting on you: putting that away would hide the very thing that
   *  needs you. */
  canSettle(groupId: string): boolean {
    return this.busy(this.terminalsIn(groupId)).length === 0;
  }

  /** Puts a group away as done: it moves to the Done shelf, its terminals
   *  keep running. If it was the selected group, the next open one is
   *  selected so the editor isn't left on something put away. */
  settleGroup(groupId: string): boolean {
    if (!this.canSettle(groupId)) return false;
    this.store.setSettled(groupId, true);
    this.leaveIfSelected(groupId);
    return true;
  }

  /** The selected group has just left the main list (settled or
   *  snoozed): selects the nearest open group after it, else before it,
   *  without taking the keyboard, so the editor isn't left on it. */
  private leaveIfSelected(groupId: string): void {
    if (this.store.activeGroupId !== groupId) return;
    const all = this.store.list();
    const index = all.findIndex((g) => g.id === groupId);
    const after = all.slice(index + 1).find(isOpenGroup);
    const before = [...all.slice(0, index)].reverse().find(isOpenGroup);
    void this.selectGroup((after ?? before)?.id ?? null, false);
  }

  /** A snooze is refused only while a session in the group needs you:
   *  hiding that defeats the request. A working session may be snoozed,
   *  since snoozing only changes what the sidebar shows, never the agent. */
  canSnooze(groupId: string): boolean {
    return !this.terminalsIn(groupId).some((view) => this.plugin.agentSessionStore.get(view.hookToken)?.status === "needs-attention");
  }

  snoozeGroup(groupId: string, until: number): boolean {
    if (!this.canSnooze(groupId)) return false;
    this.store.snooze(groupId, until);
    this.leaveIfSelected(groupId);
    return true;
  }

  /** Brings a snoozed group back at the user's request. */
  unsnoozeGroup(groupId: string): void {
    this.store.unsnooze(groupId, false);
  }

  private wakeTimer: number | null = null;

  private clearWakeTimer(): void {
    if (this.wakeTimer !== null) window.clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  /** One timer, for the earliest wake; set again after it fires or the
   *  groups change. */
  private scheduleWake(): void {
    this.clearWakeTimer();
    const next = this.store.nextWake();
    if (next === null) return;
    // setTimeout takes at most about 24 days; a longer snooze re-checks then.
    const delay = Math.min(Math.max(1000, next - Date.now()), 2_000_000_000);
    this.wakeTimer = window.setTimeout(() => {
      this.wakeTimer = null;
      this.wakeDue();
      this.scheduleWake();
    }, delay);
  }

  /** Groups whose snooze has run out come back, marked "Woke". */
  private wakeDue(): void {
    const now = Date.now();
    for (const group of this.store.list()) {
      if (group.snoozedUntil !== null && group.snoozedUntil <= now) this.store.unsnooze(group.id, true, group.snoozedUntil);
    }
  }

  /** A snoozed group wakes early when a session in it needs you, or when
   *  a turn has ended since it was snoozed (finished, or failed). */
  private wakeForSession(token: string): void {
    if (!this.multiAgent) return;
    const session = this.plugin.agentSessionStore.get(token);
    if (!session) return;
    const groupId = this.terminals().find((view) => view.hookToken === token)?.groupId;
    const group = this.store.get(groupId);
    if (!group || group.snoozedUntil === null) return;
    const turnEnded = session.lastTurnEndedAt !== null && session.lastTurnEndedAt > (group.snoozedAt ?? 0);
    if (session.status === "needs-attention" || turnEnded) this.store.unsnooze(group.id, true);
  }

  unsettleGroup(groupId: string): void {
    this.store.setSettled(groupId, false);
  }

  /** A settled group whose session starts work or needs you isn't done: it
   *  comes back out. (t3code's "raise a hand" on a snoozed thread.) */
  private unsettleForSession(token: string): void {
    if (!this.multiAgent) return;
    const status = this.plugin.agentSessionStore.get(token)?.status;
    if (status !== "working" && status !== "needs-attention") return;
    const groupId = this.terminals().find((view) => view.hookToken === token)?.groupId;
    const group = this.store.get(groupId);
    if (group && group.settledAt !== null) this.store.setSettled(group.id, false);
  }

  /** Closes a group's terminals and removes it. Its other tabs stay open
   *  and become global: they may hold unsaved edits. */
  closeGroup(groupId: string): void {
    for (const view of this.terminalsIn(groupId)) view.leaf.detach();
    this.store.remove(groupId);
  }

  /** Sessions in these terminals that are mid-turn or waiting on an
   *  answer: closing them interrupts Claude, so it's asked about first. */
  busy(terminals: TerminalView[]): TerminalView[] {
    return terminals.filter((view) => {
      const status = this.plugin.agentSessionStore.get(view.hookToken)?.status;
      return status === "working" || status === "needs-attention";
    });
  }
}
