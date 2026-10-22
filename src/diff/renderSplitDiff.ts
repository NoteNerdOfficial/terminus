import { App, Notice } from "obsidian";
import { pathBasename } from "terminus-node-bridge";
import { diffWordsWithSpace } from "diff";
import { buildDiffLines, buildSegments, DiffLineSegment, splitLines } from "./buildDiffLines";
import { renderMinimap } from "./renderDiff";
import { computeSplitParts, HunkPart } from "./hunks";
import { PendingChange, PendingChangesStore } from "../state/PendingChangesStore";
import { errorMessage } from "../util/errors";
import { confirmCollisionReject, diffBaselines } from "../modals/collisions";
import type { FeedbackStore } from "../state/FeedbackStore";

/**
 * Per-hunk comments (Multi-agent only). `drafts` and `open` belong to the
 * hosting view, so an open comment box and its text survive the re-render
 * every store change causes (Claude may still be editing the file).
 */
/** Which left-hand side the body is drawn against, and how to change it.
 *  Owned by the hosting view so the choice survives the re-render every
 *  store change causes. */
export interface CompareContext {
  index: number;
  onPick: (index: number) => void;
}

export interface HunkCommentContext {
  feedback: FeedbackStore;
  /** The session that gets the comments: the terminal that made the change. */
  token: string;
  terminalLabel: string;
  drafts: Map<string, string>;
  open: Set<string>;
}

interface CellLine {
  text: string;
  segments: DiffLineSegment[];
}

// Context runs longer than this get collapsed to their first/last EDGE lines
// with an untruncate divider in between -- otherwise a long untouched file
// with one small edit would render as a wall of unchanged lines before you
// reach the part worth reviewing.
const EDGE = 4;
const MIN_HIDDEN_TO_TRUNCATE = 4;

/**
 * Renders a side-by-side (old | new) split diff for one pending change:
 * unchanged runs (truncated/untruncate-able), and hunks with their own
 * Accept/Reject bar (styled like the inline editor overlay's controls) so
 * each change can be resolved independently. Line numbers run separately
 * per side; rows within a hunk are padded to equal height on both sides so
 * the two columns share one scrollbar. A minimap reusing the same tick/
 * viewport styling as the unified diff view sits along the edge as a scroll
 * marker.
 */
export function renderSplitDiffBody(
  container: HTMLElement,
  app: App,
  store: PendingChangesStore,
  change: PendingChange,
  comments?: HunkCommentContext,
  compare?: CompareContext
): void {
  const { diff } = change;

  // More than one baseline means a second terminal edited this file, and
  // the version it overwrote can be put in the left column instead of the
  // original. Acting on a hunk stays bound to the original: resolveHunk
  // splices against diff.oldText and numbers hunks from it, so indices
  // taken from any other baseline would cut the wrong text.
  const baselines = diffBaselines(change);
  const picked = Math.min(Math.max(compare?.index ?? 0, 0), baselines.length - 1);
  const left = baselines[picked] ?? { label: "Original", text: diff.oldText };
  const actionable = picked === 0;

  const wrapper = container.createDiv({ cls: "terminus-split-diff-wrapper terminus-diff-body-wrapper" });

  if (compare && baselines.length > 1) {
    const bar = wrapper.createDiv({ cls: "terminus-split-diff-compare" });
    bar.createSpan({ cls: "terminus-split-diff-compare-label", text: "Compare with" });
    baselines.forEach((baseline, index) => {
      const button = bar.createEl("button", {
        cls: "terminus-split-diff-compare-option",
        text: baseline.label,
      });
      button.toggleClass("is-active", index === picked);
      button.setAttr("aria-pressed", String(index === picked));
      button.addEventListener("click", () => compare.onPick(index));
    });
    if (!actionable) {
      bar.createSpan({
        cls: "terminus-split-diff-compare-note",
        text: "Accept and Reject act on the original. Switch back to use them.",
      });
    }
  }

  // The right column is always the current file, which is the LAST
  // contributor's work. Naming them matters once a left column can say
  // "Before Pricing copy's edits": "Claude's edit" opposite that leaves
  // whose version you are looking at unsaid. With a single terminal there
  // is no one to disambiguate from, so the familiar label stays.
  //
  // The session, not the turn: promptIds can hold several turns for one
  // row and newText is only the latest state, so a turn label would be
  // wrong as soon as a session came back to the file.
  const lastContributor = change.contributors[change.contributors.length - 1];
  const rightLabel =
    change.contributors.length > 1 && lastContributor ? `${lastContributor.label}'s version` : "Claude's edit";

  const colHeader = wrapper.createDiv({ cls: "terminus-split-diff-colheader" });
  colHeader.createDiv({ cls: "terminus-split-diff-colheader-cell", text: left.label });
  colHeader.createDiv({ cls: "terminus-split-diff-colheader-cell", text: rightLabel });

  const scrollBody = wrapper.createDiv({ cls: "terminus-split-diff-scroll" });
  const parts = computeSplitParts(left.text, diff.newText);

  let oldLineNo = 1;
  let newLineNo = 1;

  for (const part of parts) {
    if (part.type === "context") {
      const lines = splitLines(part.value);
      renderContextBlock(scrollBody, lines, oldLineNo, newLineNo);
      oldLineNo += lines.length;
      newLineNo += lines.length;
      continue;
    }

    const { oldLines, newLines } = buildHunkSides(part.oldValue, part.newValue);
    const lineSpan = (start: number, count: number) => (count > 0 ? { start, end: start + count - 1 } : null);
    renderHunkControls(scrollBody, part, change, app, store, actionable ? comments : undefined, {
      oldLines: lineSpan(oldLineNo, oldLines.length),
      newLines: lineSpan(newLineNo, newLines.length),
    }, actionable);
    const rowCount = Math.max(oldLines.length, newLines.length);
    for (let k = 0; k < rowCount; k++) {
      const oldCell = oldLines[k];
      const newCell = newLines[k];
      renderSplitRow(scrollBody, {
        oldLineNumber: oldCell ? oldLineNo++ : null,
        newLineNumber: newCell ? newLineNo++ : null,
        oldCell,
        newCell,
        oldKind: oldCell ? "remove" : "filler",
        newKind: newCell ? "add" : "filler",
      });
    }
  }

  renderMinimap(wrapper, scrollBody, buildDiffLines(left.text, diff.newText));
}

function buildHunkSides(oldValue: string, newValue: string): { oldLines: CellLine[]; newLines: CellLine[] } {
  const oldRaw = splitLines(oldValue);
  const newRaw = splitLines(newValue);

  if (oldRaw.length > 0 && newRaw.length > 0 && oldRaw.length === newRaw.length) {
    const oldLines: CellLine[] = [];
    const newLines: CellLine[] = [];
    for (let k = 0; k < oldRaw.length; k++) {
      const oldLine = oldRaw[k];
      const newLine = newRaw[k];
      if (oldLine === undefined || newLine === undefined) continue;
      const wordParts = diffWordsWithSpace(oldLine, newLine);
      oldLines.push({ text: oldLine, segments: buildSegments(wordParts, "removed") });
      newLines.push({ text: newLine, segments: buildSegments(wordParts, "added") });
    }
    return { oldLines, newLines };
  }

  return {
    oldLines: oldRaw.map((text) => ({ text, segments: [{ text, emphasis: true }] })),
    newLines: newRaw.map((text) => ({ text, segments: [{ text, emphasis: true }] })),
  };
}

function renderContextBlock(container: HTMLElement, lines: string[], oldStart: number, newStart: number): void {
  const asCell = (text: string): CellLine => ({ text, segments: [{ text, emphasis: false }] });
  const renderContextRow = (target: HTMLElement, text: string, oldLineNumber: number, newLineNumber: number) => {
    const cell = asCell(text);
    renderSplitRow(target, {
      oldLineNumber,
      newLineNumber,
      oldCell: cell,
      newCell: cell,
      oldKind: "context",
      newKind: "context",
    });
  };

  const hiddenCount = lines.length - EDGE * 2;
  if (hiddenCount < MIN_HIDDEN_TO_TRUNCATE) {
    lines.forEach((text, i) => renderContextRow(container, text, oldStart + i, newStart + i));
    return;
  }

  lines.slice(0, EDGE).forEach((text, i) => renderContextRow(container, text, oldStart + i, newStart + i));

  const divider = container.createDiv({ cls: "terminus-split-diff-truncate-divider" });
  const label = () => `⋯ ${hiddenCount} unchanged ${hiddenCount === 1 ? "line" : "lines"} ⋯`;
  const btn = divider.createEl("button", { text: label(), cls: "terminus-split-diff-untruncate" });

  const hiddenContainer = container.createDiv({ cls: "terminus-split-diff-hidden-block" });
  hiddenContainer.hide();
  lines
    .slice(EDGE, lines.length - EDGE)
    .forEach((text, i) => renderContextRow(hiddenContainer, text, oldStart + EDGE + i, newStart + EDGE + i));

  let expanded = false;
  btn.addEventListener("click", () => {
    expanded = !expanded;
    hiddenContainer.toggle(expanded);
    btn.setText(expanded ? "▲ Hide unchanged lines" : label());
  });

  lines
    .slice(lines.length - EDGE)
    .forEach((text, i) => renderContextRow(container, text, oldStart + lines.length - EDGE + i, newStart + lines.length - EDGE + i));
}

/** Same visual language as the inline editor overlay's Accept/Reject bar
 *  (see editor/inlineDiff.ts's DiffControlsWidget) -- reuses its exact CSS
 *  classes so per-hunk controls here read as the same control, just placed
 *  inline in a scrollable panel instead of floating over live editor text. */
function renderHunkControls(
  container: HTMLElement,
  hunk: HunkPart,
  change: PendingChange,
  app: App,
  store: PendingChangesStore,
  comments: HunkCommentContext | undefined,
  lines: { oldLines: { start: number; end: number } | null; newLines: { start: number; end: number } | null },
  actionable = true
): void {
  const bar = container.createDiv({ cls: "terminus-inline-diff-controls terminus-split-diff-hunk-controls" });
  bar.createSpan({ cls: "terminus-inline-diff-label", text: `Change ${hunk.index + 1}` });

  // Against a baseline other than the original these hunks do not line up
  // with the ones resolveHunk would cut, and a comment can carry a reject,
  // so the whole bar goes read-only rather than offering actions that
  // would apply somewhere else in the file.
  if (!actionable) {
    bar.createSpan({ cls: "terminus-split-diff-hunk-readonly", text: "View only" });
    return;
  }

  /** Resolves true once the hunk is resolved, false if cancelled or failed. */
  const resolve = async (accepted: boolean): Promise<boolean> => {
    if (!accepted && !(await confirmCollisionReject(app, [store.get(change.id) ?? change], "hunk"))) return false;
    try {
      await store.resolveHunk(change.id, hunk.index, accepted);
      return true;
    } catch (err: unknown) {
      new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} this change in ${pathBasename(change.diff.filePath)}: ${errorMessage(err)}`);
      return false;
    }
  };

  if (comments) {
    const key = `${change.id}:${hunk.oldStart}:${hunk.newStart}`;
    bar.createEl("button", { text: "Comment", cls: "terminus-inline-diff-comment" }).addEventListener("click", () => {
      if (comments.open.has(key)) return;
      comments.open.add(key);
      renderCommentBox(bar, key, hunk, change, comments, lines, resolve);
    });
    if (comments.open.has(key)) {
      // Re-opened after a re-render, once the hunk rows below are in place.
      window.setTimeout(() => renderCommentBox(bar, key, hunk, change, comments, lines, resolve), 0);
    }
  }

  bar.createEl("button", { text: "Reject", cls: "terminus-inline-diff-reject" }).addEventListener("click", () => void resolve(false));
  bar.createEl("button", { text: "Accept", cls: "terminus-inline-diff-accept mod-cta" }).addEventListener("click", () => void resolve(true));
}

/** The comment box under a hunk's bar: queue a comment for the session, or
 *  reject the hunk and say why in one step. */
function renderCommentBox(
  bar: HTMLElement,
  key: string,
  hunk: HunkPart,
  change: PendingChange,
  comments: HunkCommentContext,
  lines: { oldLines: { start: number; end: number } | null; newLines: { start: number; end: number } | null },
  resolve: (accepted: boolean) => Promise<boolean>
): void {
  if (!bar.isConnected || bar.nextElementSibling?.hasClass("terminus-split-diff-comment-box")) return;
  const box = createDiv({ cls: "terminus-split-diff-comment-box" });
  bar.after(box);
  const input = box.createEl("textarea", {
    cls: "terminus-split-diff-comment-input",
    attr: { placeholder: "What should Claude change here?", rows: "3" },
  });
  input.value = comments.drafts.get(key) ?? "";
  input.addEventListener("input", () => comments.drafts.set(key, input.value));

  const close = () => {
    comments.open.delete(key);
    comments.drafts.delete(key);
    box.remove();
  };
  // Queuing re-renders the view, which rebuilds any box still marked open:
  // callers close() first, so the comment text is read here, not from it.
  const queue = (rejected: boolean, comment: string) =>
    comments.feedback.add({
      token: comments.token,
      terminalLabel: comments.terminalLabel,
      filePath: change.diff.filePath,
      oldLines: lines.oldLines,
      newLines: lines.newLines,
      excerpt: hunk.newValue || hunk.oldValue,
      comment,
      rejected,
    });

  const actions = box.createDiv({ cls: "terminus-split-diff-comment-actions" });
  actions.createEl("button", { text: "Cancel" }).addEventListener("click", close);
  const rejectButton = actions.createEl("button", { text: "Reject with comment", cls: "terminus-inline-diff-reject" });
  const addButton = actions.createEl("button", { text: "Add comment", cls: "mod-cta" });
  const refresh = () => {
    const empty = input.value.trim() === "";
    rejectButton.disabled = empty;
    addButton.disabled = empty;
  };
  input.addEventListener("input", refresh);
  refresh();

  addButton.addEventListener("click", () => {
    const comment = input.value.trim();
    if (comment === "") return;
    close();
    queue(false, comment);
  });
  rejectButton.addEventListener("click", () => {
    if (input.value.trim() === "") return;
    void (async () => {
      // The comment is queued only once the reject went through, so it
      // never says "rejected" about a hunk that's still there.
      // Not open while the reject re-renders the view, so the box isn't
      // rebuilt for a hunk that's about to be gone.
      comments.open.delete(key);
      if (!(await resolve(false))) {
        comments.open.add(key);
        return;
      }
      const comment = input.value.trim();
      close();
      queue(true, comment);
    })();
  });
  input.focus();
}

interface SplitRowSpec {
  oldLineNumber: number | null;
  newLineNumber: number | null;
  oldCell?: CellLine;
  newCell?: CellLine;
  oldKind: "context" | "add" | "remove" | "filler";
  newKind: "context" | "add" | "remove" | "filler";
}

function renderSplitRow(container: HTMLElement, spec: SplitRowSpec): void {
  const row = container.createDiv({ cls: "terminus-split-diff-row" });
  renderSplitCell(row, "old", spec.oldKind, spec.oldLineNumber, spec.oldCell);
  renderSplitCell(row, "new", spec.newKind, spec.newLineNumber, spec.newCell);
}

function renderSplitCell(
  row: HTMLElement,
  side: "old" | "new",
  kind: "context" | "add" | "remove" | "filler",
  lineNumber: number | null,
  cellLine: CellLine | undefined
): void {
  const cell = row.createDiv({
    cls: `terminus-split-diff-cell terminus-split-diff-cell-${side} terminus-split-diff-cell-${kind}`,
  });
  if (kind === "filler") return;

  cell.createSpan({ cls: "terminus-diff-gutter-num", text: lineNumber !== null ? String(lineNumber) : "" });

  const content = cell.createSpan({ cls: "terminus-diff-content" });
  for (const segment of cellLine?.segments ?? []) {
    if (segment.emphasis) {
      content.createSpan({
        cls: kind === "remove" ? "terminus-diff-remove" : kind === "add" ? "terminus-diff-add" : undefined,
        text: segment.text,
      });
    } else {
      content.appendChild(activeDocument.createTextNode(segment.text));
    }
  }
}
