import { TypedEmitter } from "../node/emitter";

/**
 * Passages of notes the user marked Keep (see noteReview.ts), for the
 * Obsidian session: marked in the editor (keepMarks.ts) and checked against
 * every edit Claude makes to that note.
 *
 * A Keep is found by its text, not its line, so edits elsewhere in the note
 * that move it up or down don't lose it. It counts as broken only when an
 * edit of Claude's took it away: present before that edit, gone after it.
 * The user changing it themselves never sets it off. Nothing here needs
 * Obsidian, so it can be tested on its own.
 */

export interface KeptPassage {
  id: number;
  /** The note, absolute. */
  filePath: string;
  /** The kept text, exactly as selected. */
  text: string;
  /** 1-based line it started on when kept: picks the right one when the same
   *  text appears more than once. */
  line: number;
  /** Why, if the user said. */
  reason: string;
  /** Set once an edit of Claude's changed it: who, and when. */
  broken: { by: string; at: number } | null;
  createdAt: number;
}

type NoteKeepsEvents = {
  change: [];
};

export class NoteKeeps extends TypedEmitter<NoteKeepsEvents> {
  private keeps: KeptPassage[] = [];
  private nextId = 1;

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  add(input: { filePath: string; text: string; line: number; reason: string }): KeptPassage {
    const text = normalise(input.text);
    // The same passage kept twice is one Keep; the newer reason wins.
    const existing = this.keeps.find((keep) => keep.filePath === input.filePath && keep.text === text);
    if (existing) {
      existing.reason = input.reason || existing.reason;
      existing.broken = null;
      this.emit("change");
      return existing;
    }
    const keep: KeptPassage = { id: this.nextId++, filePath: input.filePath, text, line: input.line, reason: input.reason, broken: null, createdAt: this.now() };
    this.keeps.push(keep);
    this.emit("change");
    return keep;
  }

  remove(id: number): void {
    const before = this.keeps.length;
    this.keeps = this.keeps.filter((keep) => keep.id !== id);
    if (this.keeps.length !== before) this.emit("change");
  }

  forFile(filePath: string): KeptPassage[] {
    return this.keeps.filter((keep) => keep.filePath === filePath);
  }

  /** The Keeps on a note that an edit of Claude's has changed. */
  brokenIn(filePath: string): KeptPassage[] {
    return this.forFile(filePath).filter((keep) => keep.broken !== null);
  }

  /**
   * After Claude edits a note: marks each Keep the edit took away, and
   * clears one that's back (the edit was undone, or rejected). Returns the
   * ones newly broken, for a notice.
   */
  checkEdit(filePath: string, oldText: string, newText: string, by: string): KeptPassage[] {
    const before = normalise(oldText);
    const after = normalise(newText);
    const newlyBroken: KeptPassage[] = [];
    let changed = false;
    for (const keep of this.forFile(filePath)) {
      if (after.includes(keep.text)) {
        if (keep.broken) {
          keep.broken = null;
          changed = true;
        }
        continue;
      }
      if (keep.broken || !before.includes(keep.text)) continue;
      keep.broken = { by, at: this.now() };
      newlyBroken.push(keep);
      changed = true;
    }
    if (changed) this.emit("change");
    return newlyBroken;
  }

  /** The note as it stands now (after a rejected edit, say): a broken Keep
   *  whose text is back is whole again. */
  recheck(filePath: string, text: string): void {
    const current = normalise(text);
    let changed = false;
    for (const keep of this.brokenIn(filePath)) {
      if (current.includes(keep.text)) {
        keep.broken = null;
        changed = true;
      }
    }
    if (changed) this.emit("change");
  }
}

function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Where a kept passage is in a note now, as character offsets: the
 * occurrence nearest the line it was kept on. Null when it isn't there.
 */
export function locateKeep(doc: string, keep: Pick<KeptPassage, "text" | "line">, lineOf: (offset: number) => number): { from: number; to: number } | null {
  let best: { from: number; to: number } | null = null;
  let bestDistance = Infinity;
  for (let at = doc.indexOf(keep.text); at !== -1; at = doc.indexOf(keep.text, at + 1)) {
    const distance = Math.abs(lineOf(at) - keep.line);
    if (distance < bestDistance) {
      best = { from: at, to: at + keep.text.length };
      bestDistance = distance;
    }
  }
  return best;
}
