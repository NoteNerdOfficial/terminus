import { App } from "obsidian";
import { pathBasename } from "terminus-node-bridge";
import { ConfirmModal } from "./ConfirmModal";
import { owningContributor, type ChangeContributor, type PendingChange } from "../state/PendingChangesStore";

/**
 * Cross-terminal collisions: a pending change whose file was edited by more
 * than one terminal. PendingChangesStore coalesces every edit to a file into
 * one row that keeps the FIRST edit's pre-edit snapshot, so rejecting it
 * undoes the later terminals' edits too. These helpers name that in the UI
 * and confirm before any reject that would do it.
 */

/** Terminals that edited the file after the first one, whose pre-edit
 *  snapshot is the one the row keeps and a reject restores. */
export function laterContributors(change: PendingChange): ChangeContributor[] {
  return change.contributors.slice(1);
}

/** Terminals that edited the file other than the one it is filed under
 *  (see owningContributor): the work the row carries besides its own
 *  session's. "Also edited by Docs pass" for a row, or null. */
export function otherContributorsLabel(change: PendingChange): string | null {
  const others = change.contributors.slice(0, -1);
  return others.length ? `Also edited by ${joinNames(others)}` : null;
}

export function hasCollision(change: PendingChange): boolean {
  return change.contributors.length > 1;
}

/** "Docs pass", "Docs pass and Scratch", "Docs pass, Scratch and Terminus 4". */
function joinNames(contributors: ChangeContributor[]): string {
  const names = contributors.map((c) => c.label);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Also edited by Docs pass" for a Split Diff header, or null: the
 *  terminals that edited after the first, which is what that header goes on
 *  to explain a reject in terms of. A row is filed under the LAST of them,
 *  so for a row use otherContributorsLabel instead. */
export function collisionLabel(change: PendingChange): string | null {
  const later = laterContributors(change);
  return later.length ? `Also edited by ${joinNames(later)}` : null;
}

/**
 * Confirms before rejecting changes that include another terminal's work.
 * Resolves true straight away when none of `changes` has a collision, so
 * callers can call it on every reject. Always asks otherwise, whatever
 * "Confirm before bulk actions" is set to: unlike an ordinary reject, the
 * user may not know the other terminal's work is in there at all.
 *
 * `scope` "hunk" is a single Split Diff hunk, which only reverts that hunk's
 * lines, so it may or may not touch the other terminal's edits.
 */
export async function confirmCollisionReject(app: App, changes: PendingChange[], scope: "file" | "hunk" = "file"): Promise<boolean> {
  const collided = changes.filter(hasCollision);
  if (collided.length === 0) return true;

  if (changes.length === 1 && collided[0]) {
    const change = collided[0];
    const first = change.contributors[0]?.label ?? change.panelLabel;
    const others = joinNames(laterContributors(change));
    const file = pathBasename(change.diff.filePath);
    const message =
      scope === "hunk"
        ? `${others} also edited ${file} after ${first}. Rejecting this change restores its lines to how they were before ${first}'s first edit, which may undo ${others}'s edits too.`
        : `${others} also edited this file after ${first}. Rejecting restores it to how it was before ${first}'s first edit, which undoes ${others}'s edits too.`;
    return ConfirmModal.confirm(app, scope === "hunk" ? "Reject this change?" : `Reject ${file}?`, message, "Reject");
  }

  const SHOWN = 3;
  const listed = collided
    .slice(0, SHOWN)
    .map((c) => `${pathBasename(c.diff.filePath)} (${joinNames(laterContributors(c))})`)
    .join(", ");
  const more = collided.length > SHOWN ? ` and ${collided.length - SHOWN} more` : "";
  const count = changes.length;
  return ConfirmModal.confirm(
    app,
    `Reject ${count} ${count === 1 ? "file" : "files"}?`,
    `${collided.length} of them ${collided.length === 1 ? "was" : "were"} also edited by another terminal: ${listed}${more}. ` +
      "Rejecting restores each file to how it was before the first terminal's edit, which undoes the other terminals' edits too.",
    "Reject"
  );
}

/**
 * Confirms before accepting ONE hunk of a file more than one terminal
 * edited, while other hunks are still undecided.
 *
 * resolveHunk writes the row's baseline with the chosen hunk spliced into
 * it, and that baseline predates the FIRST terminal's edit. So between the
 * first Accept and the last, the file on disk holds neither terminal's work
 * except in the hunks already decided: everything comes back as the rest are
 * accepted, but someone who stops half way is left with a file emptied of
 * both sessions' edits and nothing on screen saying so. Reject asks
 * (confirmCollisionReject); this is the same warning for the direction that
 * looks safe.
 *
 * `remaining` is how many hunks the row still has. One means this Accept
 * finishes the row, which leaves the file complete, so nothing is asked.
 */
export async function confirmCollisionHunkAccept(app: App, change: PendingChange, remaining: number): Promise<boolean> {
  if (!hasCollision(change) || remaining < 2) return true;
  const first = change.contributors[0]?.label ?? change.panelLabel;
  const others = joinNames(laterContributors(change));
  const file = pathBasename(change.diff.filePath);
  const rest = remaining - 1;
  return ConfirmModal.confirm(
    app,
    "Accept only this change?",
    `${others} also edited ${file} after ${first}. Until every change here is decided, the file is how it was before ` +
      `${first}'s first edit plus the ones you accept, so the other ${rest === 1 ? "change is" : `${rest} changes are`} ` +
      `out of the file meanwhile. Accepting ${rest === 1 ? "it puts it" : "them puts them"} back.`,
    "Accept"
  );
}

/** One pair of sessions that edited the same files: the one that edited
 *  first (whose pre-edit snapshot a reject restores) and the one that edited
 *  last (whose version is the one on disk, and whose card or terminal group
 *  the rows are filed under). */
export interface OverlapGroup {
  first: ChangeContributor;
  /** The last contributor, whose edit is what the file now holds. */
  last: ChangeContributor;
  /** Every later contributor, named together when there is more than one. */
  laterLabel: string;
  changes: PendingChange[];
}

/** Groups the overlapping changes by which pair of sessions made them.
 *  Order follows the changes, so the group holding the oldest change
 *  comes first. */
export function groupOverlaps(changes: PendingChange[]): OverlapGroup[] {
  const groups = new Map<string, OverlapGroup>();
  for (const change of changes) {
    if (!hasCollision(change)) continue;
    const first = change.contributors[0];
    const last = change.contributors[change.contributors.length - 1];
    if (!first || !last) continue;
    const key = change.contributors.map((c) => c.token).join(">");
    const existing = groups.get(key);
    if (existing) existing.changes.push(change);
    else groups.set(key, { first, last, laterLabel: joinNames(laterContributors(change)), changes: [change] });
  }
  return [...groups.values()];
}

/** The overlapping changes a session edited but is not filed under:
 *  another terminal edited them afterwards, so they are listed on that
 *  terminal's card and this session's own card never shows them. */
export function changesOnAnotherCard(changes: PendingChange[], token: string): PendingChange[] {
  return changes.filter(
    (c) => hasCollision(c) && owningContributor(c).token !== token && c.contributors.some((x) => x.token === token)
  );
}

/** The overlapping changes filed under a session that someone else started:
 *  the row's revertText predates this session, so rejecting reaches back
 *  past it into another terminal's work. */
export function changesStartedByAnother(changes: PendingChange[], token: string): PendingChange[] {
  return changes.filter((c) => hasCollision(c) && owningContributor(c).token === token);
}


/** A left-hand side Split Diff can compare the current file against. */
export interface DiffBaseline {
  /** Column header and selector label. */
  label: string;
  text: string;
}

/**
 * What the current content can be compared with: always the original, plus
 * the file as each later terminal found it (ChangeContributor.before). For
 * a file two terminals edited that second entry is the first terminal's
 * result, which is otherwise unreachable once the row coalesced.
 *
 * Labelled "Before X's edits" rather than "X's version": if the earlier
 * terminal came back and edited again after X, the snapshot is still
 * exactly what X found, but it is no longer that terminal's latest work.
 *
 * Only the Original survives a per-hunk resolution, which rewrites the
 * baseline the snapshots were taken against and so drops them (see
 * resolveHunk).
 */
export function diffBaselines(change: PendingChange): DiffBaseline[] {
  const baselines: DiffBaseline[] = [{ label: "Original", text: change.diff.oldText }];
  for (const contributor of change.contributors.slice(1)) {
    const text = contributor.before;
    // Nothing to offer when the snapshot was never taken (a row recorded
    // before this field existed) or is the original over again.
    if (text === undefined || text === change.diff.oldText) continue;
    baselines.push({ label: `Before ${contributor.label}'s edits`, text });
  }
  return baselines;
}
