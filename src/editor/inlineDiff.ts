import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { diffWordsWithSpace } from "diff";

export interface InlineDiffOverlay {
  id: string;
  oldText: string;
  newText: string;
  onAccept: () => void;
  onReject: () => void;
}

export const setInlineDiff = StateEffect.define<InlineDiffOverlay | null>();

export const inlineDiffField = StateField.define<InlineDiffOverlay | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setInlineDiff)) value = effect.value;
    }
    return value;
  },
});

export const inlineDiffDecorations = EditorView.decorations.compute([inlineDiffField], (state) => {
  const overlay = state.field(inlineDiffField);
  if (!overlay) return Decoration.none;
  return buildDecorations(state, overlay);
});

/** A word/phrase that existed before the edit but is gone now -- the
 *  document no longer contains it, so it's rendered as an inline
 *  struck-through ghost rather than a real decoration on document text.
 *  Inline (not block): removed text is often mid-line (a replaced word or
 *  phrase), so it needs to flow with the surrounding kept/added text on the
 *  same visual line, not force a separate line of its own. */
class RemovedGhostWidget extends WidgetType {
  constructor(private text: string) {
    super();
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "terminus-inline-diff-remove-line";
    span.textContent = this.text;
    return span;
  }
  eq(other: RemovedGhostWidget): boolean {
    return other.text === this.text;
  }
}

class DiffControlsWidget extends WidgetType {
  constructor(private overlay: InlineDiffOverlay) {
    super();
  }
  toDOM(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "terminus-inline-diff-controls";
    const label = document.createElement("span");
    label.className = "terminus-inline-diff-label";
    label.textContent = "Terminus · applied change";
    bar.appendChild(label);

    const reject = document.createElement("button");
    reject.textContent = "Reject";
    reject.className = "terminus-inline-diff-reject";
    reject.addEventListener("click", (e) => {
      e.preventDefault();
      this.overlay.onReject();
    });

    const accept = document.createElement("button");
    accept.textContent = "Accept";
    accept.className = "terminus-inline-diff-accept mod-cta";
    accept.addEventListener("click", (e) => {
      e.preventDefault();
      this.overlay.onAccept();
    });

    bar.appendChild(reject);
    bar.appendChild(accept);
    return bar;
  }
  // Always rebuild: the widget closes over onAccept/onReject callbacks tied
  // to a specific pending change, so two overlays must never be treated as
  // interchangeable just because their visible diff text happens to match.
  eq(): boolean {
    return false;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * The change has already been written to disk by the time this overlay is
 * shown (see ReviewServer/PendingChangesStore) -- the live document holds
 * exactly `newText`, not `oldText`. That equality is what makes this
 * simple: walking a word-level diff and accumulating how many characters
 * of newText we've consumed so far gives a position that's *directly* a
 * document offset (both are 0-indexed character counts), no separate
 * line-number bookkeeping needed. Added/unchanged words consume that
 * position (they're real document text); removed words don't (they no
 * longer exist there) and are rendered as inline ghosts anchored at
 * wherever we currently are.
 */
function buildDecorations(state: EditorState, overlay: InlineDiffOverlay): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const parts = diffWordsWithSpace(overlay.oldText, overlay.newText);
  const docLen = state.doc.length;

  let newTextPos = 0;
  let controlsPlaced = false;

  const placeControlsNear = (pos: number) => {
    if (controlsPlaced) return;
    const clamped = Math.min(Math.max(pos, 0), docLen);
    const lineStart = state.doc.lineAt(clamped).from;
    ranges.push(Decoration.widget({ widget: new DiffControlsWidget(overlay), side: -1, block: true }).range(lineStart));
    controlsPlaced = true;
  };

  for (const part of parts) {
    if (part.removed) {
      const pos = Math.min(newTextPos, docLen);
      placeControlsNear(pos);
      ranges.push(Decoration.widget({ widget: new RemovedGhostWidget(part.value), side: -1 }).range(pos));
      continue; // removed text isn't part of newText -- doesn't advance position
    }

    if (part.added) {
      const from = Math.min(newTextPos, docLen);
      const to = Math.min(newTextPos + part.value.length, docLen);
      placeControlsNear(from);
      if (to > from) {
        ranges.push(Decoration.mark({ class: "terminus-diff-add" }).range(from, to));
      }
    }

    newTextPos += part.value.length;
  }

  return Decoration.set(ranges, true);
}
