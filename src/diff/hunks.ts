import { diffLines } from "diff";

export interface ContextPart {
  type: "context";
  value: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface HunkPart {
  type: "hunk";
  /** Stable within one computeSplitParts() call -- the Split Diff view uses
   *  this to address a specific hunk for accept/reject. Callers must not
   *  cache it across a subsequent oldText/newText mutation: resolving any
   *  hunk changes the text those offsets/indices are computed from, so the
   *  next decision always has to recompute from the current diff. */
  index: number;
  oldValue: string;
  newValue: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export type SplitPart = ContextPart | HunkPart;

/**
 * Groups diffLines() output into context runs (identical on both sides) and
 * hunks (a removed block, an added block, or a matched removed+added pair),
 * each carrying the exact character offsets it occupies in oldText/newText.
 * This is the single source of truth for hunk boundaries -- both the Split
 * Diff renderer (which needs the offsets to know what to display) and
 * PendingChangesStore.resolveHunk (which needs them to splice a per-hunk
 * decision back into oldText/newText) derive from this same grouping, so a
 * hunk index always means the same thing in both places for a given
 * oldText/newText pair.
 */
export function computeSplitParts(oldText: string, newText: string): SplitPart[] {
  const diffParts = diffLines(oldText, newText);
  const result: SplitPart[] = [];
  let oldPos = 0;
  let newPos = 0;
  let hunkIndex = 0;
  let i = 0;

  while (i < diffParts.length) {
    const part = diffParts[i]!;

    if (!part.added && !part.removed) {
      result.push({
        type: "context",
        value: part.value,
        oldStart: oldPos,
        oldEnd: oldPos + part.value.length,
        newStart: newPos,
        newEnd: newPos + part.value.length,
      });
      oldPos += part.value.length;
      newPos += part.value.length;
      i++;
      continue;
    }

    if (part.removed && diffParts[i + 1]?.added) {
      const oldValue = part.value;
      const newValue = diffParts[i + 1]!.value;
      result.push({
        type: "hunk",
        index: hunkIndex++,
        oldValue,
        newValue,
        oldStart: oldPos,
        oldEnd: oldPos + oldValue.length,
        newStart: newPos,
        newEnd: newPos + newValue.length,
      });
      oldPos += oldValue.length;
      newPos += newValue.length;
      i += 2;
      continue;
    }

    if (part.removed) {
      result.push({
        type: "hunk",
        index: hunkIndex++,
        oldValue: part.value,
        newValue: "",
        oldStart: oldPos,
        oldEnd: oldPos + part.value.length,
        newStart: newPos,
        newEnd: newPos,
      });
      oldPos += part.value.length;
      i++;
      continue;
    }

    // part.added, with no preceding removed block already consumed above
    result.push({
      type: "hunk",
      index: hunkIndex++,
      oldValue: "",
      newValue: part.value,
      oldStart: oldPos,
      oldEnd: oldPos,
      newStart: newPos,
      newEnd: newPos + part.value.length,
    });
    newPos += part.value.length;
    i++;
  }

  return result;
}

export function computeHunks(oldText: string, newText: string): HunkPart[] {
  return computeSplitParts(oldText, newText).filter((p): p is HunkPart => p.type === "hunk");
}
