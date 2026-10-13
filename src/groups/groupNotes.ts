import { FuzzySuggestModal, Notice, TFile } from "obsidian";
import type TerminusPlugin from "../main";

/**
 * A group can be linked to a note, which carries the work's status in one
 * frontmatter field, `status`. An Obsidian Bases view over that field gives
 * a board of the work without any UI here.
 *
 * Many vaults use `status` already, so Terminus only ever sets it when it's
 * missing (on linking) or when the user picks a value. Suggestions (see
 * main.ts) appear only for Terminus's own values, and nothing sets `done`
 * except the user.
 */
export const NOTE_STATUSES = ["active", "review", "parked", "done"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export function isNoteStatus(value: unknown): value is NoteStatus {
  return typeof value === "string" && (NOTE_STATUSES as readonly string[]).includes(value);
}

export function noteFile(plugin: TerminusPlugin, path: string | null): TFile | null {
  if (!path) return null;
  const file = plugin.app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
}

/** The note's `status`, whatever it holds; null when there's none. */
export function noteStatus(plugin: TerminusPlugin, file: TFile): string | null {
  const value: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.status;
  return typeof value === "string" ? value : null;
}

export async function setNoteStatus(plugin: TerminusPlugin, file: TFile, status: NoteStatus): Promise<void> {
  try {
    await plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.status = status;
    });
  } catch (err) {
    new Notice(`Terminus: couldn't update ${file.basename}'s status: ${String(err)}`);
  }
}

/** Links a note to a group, giving it `status: active` if it has no status. */
export async function linkNote(plugin: TerminusPlugin, groupId: string, file: TFile): Promise<void> {
  plugin.groupStore.setNote(groupId, file.path);
  if (noteStatus(plugin, file) !== null) return;
  try {
    await plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      frontmatter.status ??= "active";
    });
  } catch (err) {
    new Notice(`Terminus: linked ${file.basename}, but couldn't add its status: ${String(err)}`);
  }
}

/** Opens a group's note in a tab that belongs to the group. */
export async function openGroupNote(plugin: TerminusPlugin, groupId: string): Promise<void> {
  const file = noteFile(plugin, plugin.groupStore.get(groupId)?.note ?? null);
  if (!file) return;
  const leaf = plugin.app.workspace.getLeaf("tab");
  await leaf.openFile(file);
  plugin.addTabToGroup(leaf, groupId);
}

/**
 * A group named after the note, linked to it, with one terminal that starts
 * `claude` and types a first prompt naming the note -- unsent, so the user
 * reads and edits it before pressing Enter.
 */
export async function startClaudeOnNote(plugin: TerminusPlugin, file: TFile): Promise<void> {
  const group = plugin.groupStore.create();
  plugin.groupStore.rename(group.id, file.basename);
  await linkNote(plugin, group.id, file);
  await plugin.groups.newTerminal(group.id, true, { command: "claude", prompt: `Read ${file.path} and let's work on it.` });
  await plugin.groups.selectGroup(group.id);
}

/** Picks a note to link to a group. */
export class NoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    plugin: TerminusPlugin,
    private onPick: (file: TFile) => void
  ) {
    super(plugin.app);
    this.setPlaceholder("Note to link to this group");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}
