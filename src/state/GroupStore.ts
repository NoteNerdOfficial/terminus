import { TypedEmitter } from "../node/emitter";
import { NameSource, outranks, PLACEHOLDER_NAME } from "../groups/groupNaming";

/** A set of terminals for one piece of work (Multi-agent experience). Which
 *  terminals are in it lives on each terminal (TerminalView's `groupId`, in
 *  its view state), so it travels with the tab across restarts; this holds
 *  the group itself. */
export interface TerminalGroup {
  id: string;
  name: string;
  /** Where the name came from; see groupNaming.ts. Automatic names give
   *  way to stronger clues, and "user" (typed) is never replaced. */
  nameSource: NameSource;
  /** A colour tag value (see colorPalette.ts); terminals without their own
   *  colour show it. */
  color: string;
  /** Where its new terminals start; null for the vault folder. */
  folder: string | null;
  /** The linked note's vault path (see groupNotes.ts); null for none. */
  note: string | null;
  /** Folded in the sidebar: only its row shows. */
  collapsed: boolean;
  /** When the user put it away as done (Settle), or null. A settled group
   *  waits on the sidebar's Done shelf, its terminals still running, and
   *  comes back on its own when a session in it starts work or needs you. */
  settledAt: number | null;
}

/** What's saved in the plugin's data. */
export interface GroupsData {
  groups: TerminalGroup[];
  activeGroupId: string | null;
  /** Group id → leaf id of the terminal last used in it, to refocus when
   *  the group is selected. Leaf ids survive restarts; tokens don't. */
  lastLeafByGroup: Record<string, string>;
  /** Leaf id → group id for non-terminal tabs that belong to a group. */
  tabGroups: Record<string, string>;
  /** For "Group N" names; never reused, so a new group can't repeat the name
   *  of one just closed. */
  nextNumber: number;
}

export const DEFAULT_GROUPS_DATA: GroupsData = {
  groups: [],
  activeGroupId: null,
  lastLeafByGroup: {},
  tabGroups: {},
  nextNumber: 1,
};

/** Fills in whatever an older or hand-edited data.json is missing. */
export function resolveGroupsData(saved: unknown): GroupsData {
  const s = (typeof saved === "object" && saved !== null ? saved : {}) as Partial<GroupsData>;
  const groups = Array.isArray(s.groups)
    ? s.groups.filter((g): g is TerminalGroup => typeof g?.id === "string" && typeof g.name === "string" && typeof g.color === "string")
    : [];
  const ids = new Set(groups.map((g) => g.id));
  return {
    groups: groups.map((g) => ({
      ...g,
      // Groups from before automatic naming: "Group 3" was a placeholder,
      // anything else was typed.
      nameSource: isNameSource(g.nameSource) ? g.nameSource : /^Group \d+$/.test(g.name) ? "placeholder" : "user",
      folder: typeof g.folder === "string" ? g.folder : null,
      note: typeof g.note === "string" ? g.note : null,
      collapsed: g.collapsed === true,
      settledAt: typeof g.settledAt === "number" ? g.settledAt : null,
    })),
    activeGroupId: typeof s.activeGroupId === "string" && ids.has(s.activeGroupId) ? s.activeGroupId : null,
    lastLeafByGroup: isStringRecord(s.lastLeafByGroup) ? s.lastLeafByGroup : {},
    tabGroups: isStringRecord(s.tabGroups) ? s.tabGroups : {},
    nextNumber: typeof s.nextNumber === "number" && s.nextNumber >= 1 ? s.nextNumber : groups.length + 1,
  };
}

function isNameSource(value: unknown): value is NameSource {
  return typeof value === "string" && ["placeholder", "folder", "branch", "prompt", "claude", "note", "user"].includes(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && Object.values(value).every((v) => typeof v === "string");
}

type GroupStoreEvents = {
  change: [];
};

/**
 * Groups, the selected one, and which non-terminal tabs belong to which.
 * Changed only by the user's actions (create, rename, move, close, select);
 * nothing here polls. Every change is saved through `save` and announced.
 */
export class GroupStore extends TypedEmitter<GroupStoreEvents> {
  constructor(
    private data: GroupsData,
    private readonly save: () => Promise<void>,
    private readonly palette: readonly string[]
  ) {
    super();
  }

  list(): TerminalGroup[] {
    return [...this.data.groups];
  }

  get(id: string | null | undefined): TerminalGroup | undefined {
    return id ? this.data.groups.find((g) => g.id === id) : undefined;
  }

  get activeGroupId(): string | null {
    return this.data.activeGroupId;
  }

  /** A new group named "New group" until a clue names it (see autoName),
   *  in the next palette colour. */
  create(): TerminalGroup {
    const n = this.data.nextNumber;
    const group: TerminalGroup = {
      id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: PLACEHOLDER_NAME,
      nameSource: "placeholder",
      color: this.palette[(n - 1) % this.palette.length] ?? "",
      folder: null,
      note: null,
      collapsed: false,
      settledAt: null,
    };
    this.data.groups.push(group);
    this.data.nextNumber = n + 1;
    this.changed();
    return group;
  }

  /** The user's own name: final, never replaced automatically. Leaving the
   *  rename field unchanged isn't naming it. */
  rename(id: string, name: string): void {
    const group = this.get(id);
    const trimmed = name.trim();
    if (!group || !trimmed || trimmed === group.name) return;
    group.name = trimmed;
    group.nameSource = "user";
    this.changed();
  }

  /** An automatic name from a clue, applied only when that clue outranks
   *  the one the current name came from. Returns whether it was applied. */
  autoName(id: string, name: string | null, source: NameSource): boolean {
    const group = this.get(id);
    if (!group || !name || !outranks(source, group.nameSource)) return false;
    group.name = name;
    group.nameSource = source;
    this.changed();
    return true;
  }

  setColor(id: string, color: string): void {
    const group = this.get(id);
    if (!group || group.color === color) return;
    group.color = color;
    this.changed();
  }

  setFolder(id: string, folder: string | null): void {
    const group = this.get(id);
    if (!group || group.folder === folder) return;
    group.folder = folder;
    this.changed();
  }

  /** Folds or unfolds a group in the sidebar. */
  setCollapsed(id: string, collapsed: boolean): void {
    const group = this.get(id);
    if (!group || group.collapsed === collapsed) return;
    group.collapsed = collapsed;
    this.changed();
  }

  /** Moves a group to just before or after another, for the sidebar's
   *  order. Settled groups keep their places in the list; they show on the
   *  Done shelf, so only the open ones' relative order is visible. */
  moveGroup(id: string, targetId: string, where: "before" | "after"): void {
    if (id === targetId) return;
    const from = this.data.groups.findIndex((g) => g.id === id);
    if (from === -1 || !this.get(targetId)) return;
    const [group] = this.data.groups.splice(from, 1);
    const to = this.data.groups.findIndex((g) => g.id === targetId);
    this.data.groups.splice(where === "before" ? to : to + 1, 0, group!);
    this.changed();
  }

  /** One step up (-1) or down (+1) among the groups the sidebar shows
   *  (the open ones). False when it's already at that end. */
  shiftGroup(id: string, delta: -1 | 1): boolean {
    const open = this.data.groups.filter((g) => g.settledAt === null);
    const index = open.findIndex((g) => g.id === id);
    const neighbour = open[index + delta];
    if (index === -1 || !neighbour) return false;
    this.moveGroup(id, neighbour.id, delta < 0 ? "before" : "after");
    return true;
  }

  /** Puts a group away as done, or (false) back among the open ones. */
  setSettled(id: string, settled: boolean): void {
    const group = this.get(id);
    if (!group || (group.settledAt !== null) === settled) return;
    group.settledAt = settled ? Date.now() : null;
    this.changed();
  }

  setNote(id: string, path: string | null): void {
    const group = this.get(id);
    if (!group || group.note === path) return;
    group.note = path;
    this.changed();
  }

  /** Follows a linked note's rename (or deletion, with null). */
  noteMoved(oldPath: string, newPath: string | null): void {
    let changed = false;
    for (const group of this.data.groups) {
      if (group.note === oldPath) {
        group.note = newPath;
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /** Removes a group. Its tabs become global; its terminals' own `groupId`
   *  is the caller's to clear or close. */
  remove(id: string): void {
    if (!this.get(id)) return;
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    if (this.data.activeGroupId === id) this.data.activeGroupId = null;
    delete this.data.lastLeafByGroup[id];
    for (const [leafId, groupId] of Object.entries(this.data.tabGroups)) {
      if (groupId === id) delete this.data.tabGroups[leafId];
    }
    this.changed();
  }

  /** Null selects no group: only ungrouped terminals and global tabs show. */
  setActive(id: string | null): void {
    const next = id && this.get(id) ? id : null;
    if (next === this.data.activeGroupId) return;
    this.data.activeGroupId = next;
    this.changed();
  }

  lastLeaf(groupId: string): string | undefined {
    return this.data.lastLeafByGroup[groupId];
  }

  /** Remembered quietly: focusing a terminal is too frequent to save and
   *  re-render for, and losing it only means refocusing the first terminal. */
  setLastLeaf(groupId: string, leafId: string): void {
    this.data.lastLeafByGroup[groupId] = leafId;
  }

  tabGroup(leafId: string): string | undefined {
    const groupId = this.data.tabGroups[leafId];
    return groupId && this.get(groupId) ? groupId : undefined;
  }

  /** Puts a non-terminal tab in a group, or (null) back in every group. */
  setTabGroup(leafId: string, groupId: string | null): void {
    const current = this.data.tabGroups[leafId] ?? null;
    if (current === groupId) return;
    if (groupId && this.get(groupId)) this.data.tabGroups[leafId] = groupId;
    else delete this.data.tabGroups[leafId];
    this.changed();
  }

  /** Forgets tabs that no longer exist (closed while Terminus wasn't
   *  looking, e.g. with Obsidian quit). */
  pruneTabs(liveLeafIds: ReadonlySet<string>): void {
    let changed = false;
    for (const leafId of Object.keys(this.data.tabGroups)) {
      if (!liveLeafIds.has(leafId)) {
        delete this.data.tabGroups[leafId];
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  private changed(): void {
    void this.save();
    this.emit("change");
  }
}
