import { editorInfoField, Notice, setIcon, setTooltip } from "obsidian";
import { StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { pathJoin } from "terminus-node-bridge";
import { locateKeep, type KeptPassage, type NoteKeeps } from "./noteKeeps";

/** Tells every open editor to redraw its Keep marks: the Keeps changed. */
export const refreshKeepMarks = StateEffect.define<null>();

/**
 * Marks kept passages in the editor (see noteKeeps.ts): a faint highlight on
 * the text and a small lock before it. Hovering the lock says why it's
 * kept; clicking it stops protecting the passage. A Keep whose text isn't
 * in the note (the user changed it, or an edit of Claude's did) isn't
 * marked.
 */
export function keepMarksExtension(keeps: NoteKeeps, vaultBasePath: () => string): Extension {
  const build = (view: EditorView): DecorationSet => {
    const file = view.state.field(editorInfoField, false)?.file;
    if (!file) return Decoration.none;
    const list = keeps.forFile(pathJoin(vaultBasePath(), file.path));
    if (list.length === 0) return Decoration.none;
    const doc = view.state.doc;
    const text = doc.toString();
    const ranges: Range<Decoration>[] = [];
    for (const keep of list) {
      const at = locateKeep(text, keep, (offset) => doc.lineAt(offset).number);
      if (!at) continue;
      ranges.push(Decoration.widget({ widget: new LockWidget(keep, keeps), side: -1 }).range(at.from));
      ranges.push(Decoration.mark({ class: "terminus-keep-mark" }).range(at.from, at.to));
    }
    return Decoration.set(ranges, true);
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate): void {
        const refresh = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshKeepMarks)));
        if (update.docChanged || refresh) this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}

class LockWidget extends WidgetType {
  constructor(
    private readonly keep: KeptPassage,
    private readonly keeps: NoteKeeps
  ) {
    super();
  }

  eq(other: LockWidget): boolean {
    return other.keep.id === this.keep.id && other.keep.reason === this.keep.reason;
  }

  toDOM(): HTMLElement {
    const el = createSpan({ cls: "terminus-keep-lock", attr: { role: "button", tabindex: "0" } });
    setIcon(el, "lock");
    const why = this.keep.reason ? `Keep: ${this.keep.reason}` : "Kept as it is";
    setTooltip(el, `${why}. Click to stop keeping it.`);
    const remove = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
      this.keeps.remove(this.keep.id);
      new Notice("Terminus: no longer kept");
    };
    el.addEventListener("mousedown", (event) => event.preventDefault());
    el.addEventListener("click", remove);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") remove(event);
    });
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
