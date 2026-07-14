import { EventEmitter } from "events";
import * as fs from "fs/promises";
import { PreToolUseHookPayload } from "../hooks/types";
import { DiffResult } from "../server/diff";
import type { BrokenBacklink } from "../backlinks/breakage";
import { computeHunks } from "../diff/hunks";

export interface PendingChange {
  /** Always the file's absolute path -- edits to the same file within one
   *  review window coalesce into a single row (see recordChange), so this
   *  can't be a per-tool-call id like tool_use_id. */
  id: string;
  payload: PreToolUseHookPayload;
  diff: DiffResult;
  panelLabel: string;
  createdAt: number;
  /** How many tool calls have been coalesced into this row. */
  editCount: number;
  /** Populated separately via setBrokenBacklinks (computation needs the
   *  Obsidian App instance, which this store deliberately doesn't depend
   *  on -- keeps this class's core logic plain and independently testable). */
  brokenBacklinks: BrokenBacklink[];
}

export interface ResolvedChange extends PendingChange {
  historyId: number;
  accepted: boolean;
  resolvedAt: number;
}

export interface RecordChangeInput {
  payload: PreToolUseHookPayload;
  diff: DiffResult;
  panelLabel: string;
}

interface PendingEntry {
  change: PendingChange;
  /** Set while an inline editor diff overlay is showing this change, so a
   *  resolution from the sidebar panel can also clear the editor overlay. */
  onExternallyResolved?: (accepted: boolean) => void;
}

const MAX_HISTORY = 20;

/**
 * Plugin-wide list of changes Claude has already written to disk, awaiting
 * human review. The write already happened by the time an entry appears
 * here (see ReviewServer/hook-bridge.sh) -- Accept is a no-op (the file
 * already has the right content), Reject reverts the file to its pre-edit
 * content (or deletes it, if the change created a new file). Resolved
 * changes move to a bounded history so either decision can be undone.
 */
export class PendingChangesStore extends EventEmitter {
  private entries = new Map<string, PendingEntry>();
  private history: ResolvedChange[] = [];
  private historyIdCounter = 0;

  /**
   * Multiple edits to the same file within one review window merge into a
   * single row: the FIRST edit's oldText/revertText is preserved (the true
   * pre-turn snapshot) while newText/payload advance to the latest edit.
   * Without this, rejecting an earlier edit after a later one landed would
   * silently discard the later edit too, with no way to reason about it.
   */
  recordChange(input: RecordChangeInput): void {
    const key = input.diff.filePath;
    const existing = this.entries.get(key);

    const change: PendingChange = existing
      ? {
          ...existing.change,
          payload: input.payload,
          diff: { ...input.diff, oldText: existing.change.diff.oldText, revertText: existing.change.diff.revertText },
          editCount: existing.change.editCount + 1,
        }
      : {
          id: key,
          payload: input.payload,
          diff: input.diff,
          panelLabel: input.panelLabel,
          createdAt: Date.now(),
          editCount: 1,
          brokenBacklinks: [],
        };

    this.entries.set(key, { change, onExternallyResolved: existing?.onExternallyResolved });
    this.emit("change");
    // Separate from "change" (which also fires on resolve/undo/backlink-scan
    // completion, none of which should pull the panel to front) -- this
    // fires only when Claude actually adds/extends a pending edit, which is
    // the one case main.ts wants to react to by revealing the panel.
    this.emit("recorded", change);
  }

  /** Set separately from recordChange since computing it needs the Obsidian
   *  App instance (see backlinks/breakage.ts) -- a no-op if the change was
   *  already resolved before this resolves (e.g. the user accepted/rejected
   *  before the async backlink scan finished). */
  setBrokenBacklinks(id: string, brokenBacklinks: BrokenBacklink[]): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.change = { ...entry.change, brokenBacklinks };
    this.emit("change");
  }

  list(): PendingChange[] {
    return [...this.entries.values()]
      .map((e) => e.change)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PendingChange | undefined {
    return this.entries.get(id)?.change;
  }

  listHistory(): ResolvedChange[] {
    return [...this.history];
  }

  registerInlineOverlay(id: string, onExternallyResolved: (accepted: boolean) => void): void {
    const entry = this.entries.get(id);
    if (entry) entry.onExternallyResolved = onExternallyResolved;
  }

  unregisterInlineOverlay(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.onExternallyResolved = undefined;
  }

  async resolveItem(id: string, accepted: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);

    if (!accepted) {
      await this.applyOldState(entry.change.diff);
    }

    entry.onExternallyResolved?.(accepted);
    const resolved = this.pushHistory(entry.change, accepted);
    this.emit("change");
    // Separate from "change" (UI re-render) so listeners that only care
    // about completed outcomes -- e.g. the persistent action log -- don't
    // have to re-derive "what just happened" from a generic refresh signal.
    this.emit("resolved", resolved);
  }

  /** `filter`, when given, scopes this to a subset (e.g. one terminal's
   *  changes) -- omit it to resolve everything, across all terminals. */
  async resolveAll(accepted: boolean, filter?: (change: PendingChange) => boolean): Promise<void> {
    const ids = [...this.entries.values()]
      .filter((e) => !filter || filter(e.change))
      .map((e) => e.change.id);
    for (const id of ids) {
      await this.resolveItem(id, accepted);
    }
  }

  /**
   * Per-hunk accept/reject, used by the Split Diff view. `hunkIndex` must
   * come from computeHunks(entry.diff.oldText, entry.diff.newText) computed
   * fresh against the CURRENT diff -- resolving a hunk mutates oldText/
   * newText (splicing the chosen text into both, at that hunk's spot),
   * which shifts every later hunk's offsets, so indices from a previous
   * render are not valid after any resolveHunk call.
   *
   * Not supported for NotebookEdit: its oldText/newText are a display-only
   * approximation (see buildDiff in server/diff.ts), not the real file
   * content, so splicing them and writing the result to disk would corrupt
   * the notebook. The Split Diff entry point is hidden for those changes;
   * this is a second line of defense.
   */
  async resolveHunk(id: string, hunkIndex: number, accepted: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.change.payload.tool_name === "NotebookEdit") return;

    const { diff } = entry.change;
    const hunk = computeHunks(diff.oldText, diff.newText)[hunkIndex];
    if (!hunk) return;

    const chosen = accepted ? hunk.newValue : hunk.oldValue;
    const newOldText = diff.oldText.slice(0, hunk.oldStart) + chosen + diff.oldText.slice(hunk.oldEnd);
    const newNewText = diff.newText.slice(0, hunk.newStart) + chosen + diff.newText.slice(hunk.newEnd);

    // A brand-new file (existedBefore: false) whose one-and-only content
    // ends up fully rejected converges on "" -- that means "this file
    // shouldn't exist", same as the whole-item reject path below, not an
    // empty file left behind on disk.
    if (!diff.existedBefore && newOldText === "") {
      await fs.unlink(diff.filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    } else {
      await fs.writeFile(diff.filePath, newOldText, "utf8");
    }

    entry.change = { ...entry.change, diff: { ...diff, oldText: newOldText, newText: newNewText } };

    if (newOldText === newNewText) {
      // Every hunk has now been decided one way or the other -- finalize
      // like resolveItem, but the disk write above already applied the
      // combined result, so there's nothing left to write here.
      this.entries.delete(id);
      entry.onExternallyResolved?.(true);
      const resolved = this.pushHistory(entry.change, true);
      this.emit("change");
      this.emit("resolved", resolved);
      return;
    }

    this.emit("change");
  }

  /** Reverses a past Accept (restores pre-edit content) or Reject (re-applies
   *  the change that was rejected). Removes the entry from history. */
  async undo(historyId: number): Promise<void> {
    const idx = this.history.findIndex((h) => h.historyId === historyId);
    if (idx === -1) return;
    const [item] = this.history.splice(idx, 1);

    if (item.accepted) {
      await this.applyOldState(item.diff);
    } else {
      await this.applyNewState(item.diff);
    }

    this.emit("change");
    // Undoing an accept ends in the reverted state, and vice versa -- log
    // it as the flipped outcome rather than inventing a third entry type.
    this.emit("resolved", { ...item, accepted: !item.accepted, resolvedAt: Date.now() });
  }

  private pushHistory(change: PendingChange, accepted: boolean): ResolvedChange {
    const resolved: ResolvedChange = {
      ...change,
      historyId: ++this.historyIdCounter,
      accepted,
      resolvedAt: Date.now(),
    };
    this.history.unshift(resolved);
    if (this.history.length > MAX_HISTORY) this.history.pop();
    return resolved;
  }

  private async applyOldState(diff: DiffResult): Promise<void> {
    if (!diff.existedBefore) {
      await fs.unlink(diff.filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      return;
    }
    await fs.writeFile(diff.filePath, diff.revertText, "utf8");
  }

  private async applyNewState(diff: DiffResult): Promise<void> {
    await fs.writeFile(diff.filePath, diff.newText, "utf8");
  }
}
