import { Notice } from "obsidian";
import * as path from "path";
import { diffWordsWithSpace } from "diff";
import { buildDiffLines, buildSegments, DiffLineSegment, splitLines } from "./buildDiffLines";
import { renderMinimap } from "./renderDiff";
import { computeSplitParts, HunkPart } from "./hunks";
import { PendingChange, PendingChangesStore } from "../state/PendingChangesStore";

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
export function renderSplitDiffBody(container: HTMLElement, store: PendingChangesStore, change: PendingChange): void {
  const { diff } = change;

  const wrapper = container.createDiv({ cls: "terminus-split-diff-wrapper terminus-diff-body-wrapper" });

  const colHeader = wrapper.createDiv({ cls: "terminus-split-diff-colheader" });
  colHeader.createDiv({ cls: "terminus-split-diff-colheader-cell", text: "Original" });
  colHeader.createDiv({ cls: "terminus-split-diff-colheader-cell", text: "Claude's edit" });

  const scrollBody = wrapper.createDiv({ cls: "terminus-split-diff-scroll" });
  const parts = computeSplitParts(diff.oldText, diff.newText);

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

    renderHunkControls(scrollBody, part, change, store);
    const { oldLines, newLines } = buildHunkSides(part.oldValue, part.newValue);
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

  renderMinimap(wrapper, scrollBody, buildDiffLines(diff.oldText, diff.newText));
}

function buildHunkSides(oldValue: string, newValue: string): { oldLines: CellLine[]; newLines: CellLine[] } {
  const oldRaw = splitLines(oldValue);
  const newRaw = splitLines(newValue);

  if (oldRaw.length > 0 && newRaw.length > 0 && oldRaw.length === newRaw.length) {
    const oldLines: CellLine[] = [];
    const newLines: CellLine[] = [];
    for (let k = 0; k < oldRaw.length; k++) {
      const wordParts = diffWordsWithSpace(oldRaw[k]!, newRaw[k]!);
      oldLines.push({ text: oldRaw[k]!, segments: buildSegments(wordParts, "removed") });
      newLines.push({ text: newRaw[k]!, segments: buildSegments(wordParts, "added") });
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
function renderHunkControls(container: HTMLElement, hunk: HunkPart, change: PendingChange, store: PendingChangesStore): void {
  const bar = container.createDiv({ cls: "terminus-inline-diff-controls terminus-split-diff-hunk-controls" });
  bar.createEl("span", { cls: "terminus-inline-diff-label", text: `Change ${hunk.index + 1}` });

  const resolve = (accepted: boolean) => {
    store.resolveHunk(change.id, hunk.index, accepted).catch((err: Error) => {
      new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} this change in ${path.basename(change.diff.filePath)}: ${err.message}`);
    });
  };

  bar.createEl("button", { text: "Reject", cls: "terminus-inline-diff-reject" }).addEventListener("click", () => resolve(false));
  bar.createEl("button", { text: "Accept", cls: "terminus-inline-diff-accept mod-cta" }).addEventListener("click", () => resolve(true));
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

  cell.createEl("span", { cls: "terminus-diff-gutter-num", text: lineNumber !== null ? String(lineNumber) : "" });

  const content = cell.createEl("span", { cls: "terminus-diff-content" });
  for (const segment of cellLine?.segments ?? []) {
    if (segment.emphasis) {
      content.createEl("span", {
        cls: kind === "remove" ? "terminus-diff-remove" : kind === "add" ? "terminus-diff-add" : undefined,
        text: segment.text,
      });
    } else {
      content.appendChild(document.createTextNode(segment.text));
    }
  }
}
