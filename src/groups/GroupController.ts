import { WorkspaceLeaf } from "obsidian";
import { TERMINUS_VIEW_TYPE, TerminalView } from "../views/TerminalView";
import type { TerminalGroup } from "../state/GroupStore";
import type TerminusPlugin from "../main";

/** Ungrouped, or a group id. */
export type GroupTarget = string | null;

/**
 * The Multi-agent experience's groups, applied to the workspace: which
 * terminals are in which group, creating and closing groups, moving
 * terminals, and following the user into a group when they open one of its
 * terminals. Group data itself lives in GroupStore; membership lives on
 * each TerminalView. Event-driven only: never reads a terminal's view state
 * (getState() serializes its whole scrollback).
 */
export class GroupController {
  constructor(private readonly plugin: TerminusPlugin) {}

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
   * with a new terminal, since a group is never empty. Either way it becomes
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
  async newTerminal(target: GroupTarget, focus = true): Promise<TerminalView | null> {
    const { workspace } = this.plugin.app;
    const group = this.store.get(target);
    const anchorId = group ? this.store.lastLeaf(group.id) : undefined;
    const anchor = (anchorId && workspace.getLeafById(anchorId)) || this.terminalsIn(target)[0]?.leaf;
    if (anchor) workspace.setActiveLeaf(anchor, { focus: false });
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({
      type: TERMINUS_VIEW_TYPE,
      active: focus,
      state: { groupId: group?.id, cwd: group?.folder ?? undefined },
    });
    await workspace.revealLeaf(leaf);
    this.plugin.applyGroupVisibility();
    return leaf.view instanceof TerminalView ? leaf.view : null;
  }

  /** Moves terminals into a group or out of all of them, then removes any
   *  group the move left empty. */
  moveTerminals(terminals: TerminalView[], target: GroupTarget): void {
    for (const view of terminals) view.setGroup(target);
    this.removeEmptyGroups();
    // Membership lives on the terminals, so the store may not have changed.
    this.plugin.applyGroupVisibility();
    this.plugin.refreshTerminusViews();
  }

  /** Groups with no terminals left go: a group is never empty. */
  removeEmptyGroups(): void {
    const used = new Set(this.terminals().map((view) => view.groupId));
    for (const group of this.store.list()) {
      if (!used.has(group.id)) this.store.remove(group.id);
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
