import { FuzzySuggestModal, Menu, SuggestModal, TFolder, WorkspaceLeaf } from "obsidian";
import { pathJoin, pathRelative } from "terminus-node-bridge";
import { titleFromFolder } from "./groupNaming";
import { TerminalView } from "../views/TerminalView";
import type { TerminalGroup } from "../state/GroupStore";
import { openTerminalColorPicker } from "../terminal/TerminalColorPicker";
import { linkNote, NOTE_STATUSES, NoteStatus, noteFile, noteStatus, NoteSuggestModal, openGroupNote, setNoteStatus, startClaudeOnNote } from "./groupNotes";
import { GroupSuggestModal } from "./GroupSuggestModal";
import type TerminusPlugin from "../main";

/**
 * Every group menu in one place, so the same action has the same name
 * wherever it appears: "Move to <group>", "Move to new group" and "Remove
 * from group" on the ⇄ button, a terminal tab's menu, a note tab's menu and
 * the "Move tab to group…" command; and one short menu for a group itself.
 */

/** What's being moved: terminals (from the sidebar or a terminal tab), or
 *  one non-terminal tab. */
export type MoveSubject = { terminals: TerminalView[] } | { tab: WorkspaceLeaf };

function subjectGroup(plugin: TerminusPlugin, subject: MoveSubject): string | null | undefined {
  if ("tab" in subject) {
    const id = (subject.tab as WorkspaceLeaf & { id?: string }).id;
    return id ? (plugin.groupStore.tabGroup(id) ?? null) : null;
  }
  const groups = new Set(subject.terminals.map((t) => t.groupId ?? null));
  // Several terminals from different groups have no single current group.
  return groups.size === 1 ? [...groups][0] : undefined;
}

/** Moves the subject into a group, or (null) out of any. */
export function moveSubject(plugin: TerminusPlugin, subject: MoveSubject, target: string | null): void {
  if ("tab" in subject) plugin.groups.addTabToGroup(subject.tab, target, true);
  else plugin.groups.moveTerminals(subject.terminals, target);
}

/** Moves terminals into a new group and puts its name up for renaming. A
 *  group needs a terminal, so a note tab can't start one. */
export function moveToNewGroup(plugin: TerminusPlugin, terminals: TerminalView[]): void {
  void plugin.groups.createGroup(terminals).then(async (group) => (await plugin.revealSidebar())?.startRename(group.id));
}

/** "Move to <group>" for each group, "Move to new group" (terminals only)
 *  and "Remove from group" when it's in one. */
export function addMoveItems(menu: Menu, plugin: TerminusPlugin, subject: MoveSubject, onDone?: () => void): void {
  const current = subjectGroup(plugin, subject);
  const done = (fn: () => void) => () => {
    onDone?.();
    fn();
  };
  for (const group of plugin.groupStore.list()) {
    menu.addItem((item) =>
      item
        .setTitle(`Move to ${group.name}`)
        .setIcon("folder-input")
        .setChecked(current === group.id)
        .onClick(done(() => moveSubject(plugin, subject, group.id)))
    );
  }
  if ("terminals" in subject) {
    menu.addItem((item) =>
      item
        .setTitle("Move to new group")
        .setIcon("folder-plus")
        .onClick(done(() => moveToNewGroup(plugin, subject.terminals)))
    );
  }
  if (current) {
    menu.addItem((item) =>
      item
        .setTitle("Remove from group")
        .setIcon("folder-output")
        .onClick(done(() => moveSubject(plugin, subject, null)))
    );
  }
}

/** A note tab's (or file list's) Terminus items, together in one section:
 *  "Start Claude on this note", then, on a tab, the move items. */
export function addNoteMenuItems(menu: Menu, plugin: TerminusPlugin, file: { path: string; extension: string }, leaf?: WorkspaceLeaf): void {
  const note = noteFile(plugin, file.path);
  const startable = note?.extension === "md";
  const movable = !!leaf && !(leaf.view instanceof TerminalView) && plugin.groupStore.list().length > 0;
  if (!startable && !movable) return;
  menu.addSeparator();
  if (note && startable) {
    menu.addItem((item) =>
      item
        .setTitle("Start Claude on this note")
        .setIcon("square-terminal")
        .onClick(() => void startClaudeOnNote(plugin, note))
    );
  }
  if (movable && leaf) addMoveItems(menu, plugin, { tab: leaf });
}

/** A group's own menu, kept short: rename, folder, colour, its note, close.
 *  Colour and note status open pickers rather than listing every choice. */
export function showGroupMenu(evt: MouseEvent, plugin: TerminusPlugin, group: TerminalGroup, actions: { rename: () => void; close: () => void }): void {
  const anchor = evt.currentTarget instanceof HTMLElement ? evt.currentTarget : null;
  const menu = new Menu();
  menu.addItem((item) => item.setTitle("Rename").setIcon("pencil").onClick(actions.rename));
  menu.addItem((item) =>
    item
      .setTitle("Set folder…")
      .setIcon("folder")
      .onClick(() => new FolderSuggestModal(plugin, (folder) => setGroupFolder(plugin, group.id, folder)).open())
  );
  if (anchor) {
    menu.addItem((item) =>
      item
        .setTitle("Colour…")
        .setIcon("palette")
        // "None" in the shared picker leaves the colour as it is: a group
        // always has one.
        .onClick(() => openTerminalColorPicker(anchor, group.color, (color) => color && plugin.groups.setGroupColor(group.id, color)))
    );
  }
  menu.addSeparator();
  const note = noteFile(plugin, group.note);
  if (note) {
    menu.addItem((item) => item.setTitle("Open note").setIcon("file-text").onClick(() => void openGroupNote(plugin, group.id)));
    menu.addItem((item) =>
      item
        .setTitle("Note status…")
        .setIcon("list-checks")
        .onClick(() => new NoteStatusModal(plugin, noteStatus(plugin, note), (status) => void setNoteStatus(plugin, note, status)).open())
    );
    menu.addItem((item) => item.setTitle("Unlink note").setIcon("unlink").onClick(() => plugin.groupStore.setNote(group.id, null)));
  } else {
    menu.addItem((item) =>
      item
        .setTitle("Link to note…")
        .setIcon("link")
        .onClick(() => new NoteSuggestModal(plugin, (file) => void linkNote(plugin, group.id, file)).open())
    );
  }
  menu.addSeparator();
  if (group.settledAt !== null) {
    menu.addItem((item) => item.setTitle("Move out of Done").setIcon("undo-2").onClick(() => plugin.groups.unsettleGroup(group.id)));
  } else {
    menu.addItem((item) =>
      item
        .setTitle("Settle")
        .setIcon("check-circle-2")
        .setDisabled(!plugin.groups.canSettle(group.id))
        .onClick(() => plugin.groups.settleGroup(group.id))
    );
  }
  menu.addItem((item) => item.setTitle("Close group").setIcon("x").onClick(actions.close));
  menu.showAtMouseEvent(evt);
}

/** Sets where a group's new terminals start; a folder other than the vault
 *  root can also name an unnamed group (see groupNaming.ts). */
function setGroupFolder(plugin: TerminusPlugin, groupId: string, folder: string | null): void {
  plugin.groupStore.setFolder(groupId, folder);
  const relative = folder ? pathRelative(plugin.getVaultBasePath(), folder) : null;
  plugin.groupStore.autoName(groupId, titleFromFolder(relative), "folder");
}

/** The "Move tab to group…" command: whatever tab was last active. */
export function moveTabCommand(plugin: TerminusPlugin, leaf: WorkspaceLeaf): void {
  const terminal = leaf.view instanceof TerminalView ? leaf.view : null;
  const subject: MoveSubject = terminal ? { terminals: [terminal] } : { tab: leaf };
  const inGroup = !!subjectGroup(plugin, subject);
  new GroupSuggestModal(plugin, "Move this tab to", { mode: "move", offerNew: !!terminal, offerRemove: inGroup }, (choice) => {
    if (choice.kind === "new") {
      if (terminal) moveToNewGroup(plugin, [terminal]);
      return;
    }
    moveSubject(plugin, subject, choice.target);
  }).open();
}

class NoteStatusModal extends SuggestModal<NoteStatus> {
  constructor(
    plugin: TerminusPlugin,
    private current: string | null,
    private onPick: (status: NoteStatus) => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Note status");
  }

  getSuggestions(query: string): NoteStatus[] {
    return NOTE_STATUSES.filter((s) => s.includes(query.trim().toLowerCase()));
  }

  renderSuggestion(status: NoteStatus, el: HTMLElement): void {
    el.setText(status === this.current ? `${status} (current)` : status);
  }

  onChooseSuggestion(status: NoteStatus): void {
    this.onPick(status);
  }
}

/** Picks a vault folder for a group's new terminals to start in. */
class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(
    private plugin: TerminusPlugin,
    private onPick: (absolutePath: string | null) => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Folder new terminals in this group start in");
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
  }

  getItemText(folder: TFolder): string {
    return folder.isRoot() ? "/ (vault)" : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onPick(folder.isRoot() ? null : pathJoin(this.plugin.getVaultBasePath(), folder.path));
  }
}
