import { TypedEmitter } from "../node/emitter";
import { deleteFileIfExists, writeTextFile } from "terminus-node-bridge";
import { PreToolUseHookPayload } from "../hooks/types";
import { DiffResult } from "../server/diff";
import type { BrokenBacklink } from "../backlinks/breakage";
import { computeHunks } from "../diff/hunks";

/** A terminal that edited a pending change's file. `token` is the terminal's
 *  hook/review token, which (unlike its label) is unique per terminal. */
export interface ChangeContributor {
  token: string;
  label: string;
  color: string | null;
  /** The file as this terminal found it, captured when its first edit was
   *  recorded. Absent on the first contributor, whose starting point is
   *  the row's own diff.oldText.
   *
   *  This is the state the row would otherwise lose: recordChange resets
   *  oldText to the FIRST edit's baseline, so without this the version a
   *  later terminal overwrote exists nowhere once its edit lands. Split
   *  Diff offers it as an alternative left-hand side.
   *
   *  Carries buildDiff's caveat for NotebookEdit, whose oldText is a
   *  display-only approximation; the Split Diff entry point is hidden for
   *  those changes, so it is never shown.
   *
   *  A whole extra copy of the file, kept only while the row is pending and
   *  only for a file more than one terminal edited, which is in line with
   *  the three copies (oldText, newText, revertText) every row already
   *  holds. resolveHunk drops it: see the comment there. */
  before?: string;
}

/** Who inside a terminal edited a pending change's file: the lead session
 *  (`agentId` null) or one of its subagents. */
export interface ChangeAgent {
  token: string;
  agentId: string | null;
  agentType: string | null;
}

export interface PendingChange {
  /** Always the file's absolute path -- edits to the same file within one
   *  review window coalesce into a single row (see recordChange), so this
   *  can't be a per-tool-call id like tool_use_id. */
  id: string;
  payload: PreToolUseHookPayload;
  diff: DiffResult;
  panelLabel: string;
  panelColor: string | null;
  createdAt: number;
  /** How many tool calls have been coalesced into this row. */
  editCount: number;
  /** Every terminal whose edits were coalesced into this row, in the order
   *  they first edited it. The first is the one panelLabel/panelColor came
   *  from. More than one means rejecting reverts to the snapshot taken before
   *  the first terminal's edit, undoing the later terminals' work too. */
  contributors: ChangeContributor[];
  /** Every lead session or subagent whose edits were coalesced into this
   *  row, in the order they first edited it. Subagents appear only while
   *  they're tracked; otherwise their edits count as the lead's. */
  agents: ChangeAgent[];
  /** Every user turn whose edits were coalesced into this row, in the order
   *  they first touched the file. Usually one; a file Claude comes back to
   *  in a later turn before the row is reviewed has more, which is why this
   *  is a list rather than the single prompt_id its payload carries. Empty
   *  when no payload carried one. */
  promptIds: string[];
  /** Populated separately via setBrokenBacklinks (computation needs the
   *  Obsidian App instance, which this store deliberately doesn't depend
   *  on -- keeps this class's core logic plain and independently testable). */
  brokenBacklinks: BrokenBacklink[];
}

/**
 * The terminal a row is filed under: the one that edited the file LAST,
 * whose version the file on disk now holds and whose work the row's diff
 * shows. Classic's terminal groups and the Agent inbox's cards both file by
 * this, so a file two terminals edited sits in the same place whichever
 * experience you review it in.
 *
 * panelLabel/panelColor are the FIRST contributor's, so they are only the
 * fallback here, for a row somehow recorded without contributors at all.
 */
export function owningContributor(change: PendingChange): ChangeContributor {
  return (
    change.contributors[change.contributors.length - 1] ?? {
      token: "",
      label: change.panelLabel,
      color: change.panelColor,
    }
  );
}

export interface ResolvedChange extends PendingChange {
  historyId: number;
  accepted: boolean;
  resolvedAt: number;
}

export interface RecordChangeInput {
  payload: PreToolUseHookPayload;
  diff: DiffResult;
  /** The editing terminal's hook/review token. */
  token: string;
  panelLabel: string;
  panelColor: string | null;
  /** The subagent that made the edit; null or absent for the lead session. */
  agent?: { id: string; type: string } | null;
  /** The user turn the edit belongs to, from the payload's prompt_id. */
  promptId?: string;
}

interface PendingEntry {
  change: PendingChange;
  /** Set while an inline editor diff overlay is showing this change, so a
   *  resolution from the sidebar panel can also clear the editor overlay. */
  onExternallyResolved?: (accepted: boolean) => void;
}

const MAX_HISTORY = 20;

type PendingChangesStoreEvents = {
  change: [];
  recorded: [PendingChange];
  resolved: [ResolvedChange];
};

/**
 * Plugin-wide list of changes Claude has already written to disk, awaiting
 * human review. The write already happened by the time an entry appears
 * here (see ReviewServer/hook-bridge.sh) -- Accept is a no-op (the file
 * already has the right content), Reject reverts the file to its pre-edit
 * content (or deletes it, if the change created a new file). Resolved
 * changes move to a bounded history so either decision can be undone.
 */
export class PendingChangesStore extends TypedEmitter<PendingChangesStoreEvents> {
  private entries = new Map<string, PendingEntry>();
  private history: ResolvedChange[] = [];
  private historyIdCounter = 0;

  /**
   * Multiple edits to the same file within one review window merge into a
   * single row: the FIRST edit's oldText/revertText is preserved (the true
   * pre-turn snapshot) while newText/payload advance to the latest edit.
   * Without this, rejecting an earlier edit after a later one landed would
   * silently discard the later edit too, with no way to reason about it.
   *
   * The same holds when the later edit comes from a different terminal: its
   * work lands in the first terminal's row, so it's added to `contributors`
   * and the UI warns before a reject undoes it.
   */
  recordChange(input: RecordChangeInput): void {
    const key = input.diff.filePath;
    const existing = this.entries.get(key);
    const agent: ChangeAgent = { token: input.token, agentId: input.agent?.id ?? null, agentType: input.agent?.type ?? null };

    const change: PendingChange = existing
      ? {
          ...existing.change,
          payload: input.payload,
          // The baseline is the first edit's: what the file was before any
          // of them, including whether it existed at all. A later edit sees
          // the file the first one created, so taking its existedBefore
          // made rejecting a created-then-edited file leave it empty on
          // disk instead of deleting it.
          diff: {
            ...input.diff,
            oldText: existing.change.diff.oldText,
            revertText: existing.change.diff.revertText,
            existedBefore: existing.change.diff.existedBefore,
          },
          editCount: existing.change.editCount + 1,
          contributors: existing.change.contributors.some((c) => c.token === input.token)
            ? existing.change.contributors
            : [
                ...existing.change.contributors,
                // input.diff.oldText is read from disk at PreToolUse, so at
                // this moment it IS the previous terminal's result.
                { token: input.token, label: input.panelLabel, color: input.panelColor, before: input.diff.oldText },
              ],
          agents: existing.change.agents.some((a) => a.token === agent.token && a.agentId === agent.agentId)
            ? existing.change.agents
            : [...existing.change.agents, agent],
          promptIds:
            input.promptId && !existing.change.promptIds.includes(input.promptId)
              ? [...existing.change.promptIds, input.promptId]
              : existing.change.promptIds,
        }
      : {
          id: key,
          payload: input.payload,
          diff: input.diff,
          panelLabel: input.panelLabel,
          panelColor: input.panelColor,
          createdAt: Date.now(),
          editCount: 1,
          contributors: [{ token: input.token, label: input.panelLabel, color: input.panelColor }],
          agents: [agent],
          promptIds: input.promptId ? [input.promptId] : [],
          brokenBacklinks: [],
        };

    // Net zero: the file is back exactly as this review window found it --
    // created and then deleted, or edited and then changed back. There is
    // nothing to put in a diff, and neither decision can do anything (Keep
    // writes nothing; Reject restores a state the file is already in), so
    // the row is dropped rather than left asking for a decision that cannot
    // matter. resolveHunk converges on the same condition once every hunk
    // has been decided one way or the other.
    if (change.diff.oldText === change.diff.newText) {
      if (!existing) return;
      this.entries.delete(key);
      // An inline editor overlay showing this change has to come down with
      // it; the file's content stands as it is, which is what `true` says.
      existing.onExternallyResolved?.(true);
      this.emit("change");
      return;
    }

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
      await deleteFileIfExists(diff.filePath);
    } else {
      await writeTextFile(diff.filePath, newOldText);
    }

    entry.change = {
      ...entry.change,
      diff: { ...diff, oldText: newOldText, newText: newNewText },
      // ChangeContributor.before is a whole-file snapshot taken against the
      // row's original baseline. Splicing a hunk rewrites that baseline, so
      // the snapshot no longer lines up with either side: it would put a
      // pre-review copy of the file opposite a partly resolved one in Split
      // Diff's left column, and read as a baseline you could still act on.
      // Dropping it leaves only the Original, which is always in step.
      contributors: entry.change.contributors.map((c) => ({ ...c, before: undefined })),
    };

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
    if (!item) return;

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
      await deleteFileIfExists(diff.filePath);
      return;
    }
    await writeTextFile(diff.filePath, diff.revertText);
  }

  private async applyNewState(diff: DiffResult): Promise<void> {
    await writeTextFile(diff.filePath, diff.newText);
  }
}
