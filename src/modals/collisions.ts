import { App } from "obsidian";
import { pathBasename } from "terminus-node-bridge";
import { ConfirmModal } from "./ConfirmModal";
import type { ChangeContributor, PendingChange } from "../state/PendingChangesStore";

/**
 * Cross-terminal collisions: a pending change whose file was edited by more
 * than one terminal. PendingChangesStore coalesces every edit to a file into
 * one row that keeps the FIRST edit's pre-edit snapshot, so rejecting it
 * undoes the later terminals' edits too. These helpers name that in the UI
 * and confirm before any reject that would do it.
 */

/** Terminals that edited the file after the one the row belongs to. */
export function laterContributors(change: PendingChange): ChangeContributor[] {
  return change.contributors.slice(1);
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

/** "Also edited by Docs pass" for a row or Split Diff header, or null. */
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
