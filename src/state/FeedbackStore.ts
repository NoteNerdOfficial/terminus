import { TypedEmitter } from "../node/emitter";

/** One comment on a hunk, queued until it's sent to the session. */
export interface FeedbackItem {
  id: number;
  /** The terminal whose session gets it: the one that made the change. */
  token: string;
  filePath: string;
  /** 1-based, inclusive; null for a side the hunk has no lines on (a pure
   *  deletion has no new lines, a pure addition no old ones). */
  oldLines: { start: number; end: number } | null;
  newLines: { start: number; end: number } | null;
  /** The hunk's lines as Claude wrote them, or the removed lines for a pure
   *  deletion. */
  excerpt: string;
  comment: string;
  /** The hunk was rejected along with the comment: the file no longer has
   *  Claude's version of it. */
  rejected: boolean;
  createdAt: number;
}

export type NewFeedbackItem = Omit<FeedbackItem, "id" | "createdAt">;

type FeedbackStoreEvents = {
  change: [];
};

/**
 * Review comments queued per session, in memory. Kept apart from the
 * pending change they're about: commenting on a hunk and then keeping or
 * rejecting the file is the usual order, and resolving the change must not
 * drop the comment. Cleared for a session once its feedback is sent.
 */
export class FeedbackStore extends TypedEmitter<FeedbackStoreEvents> {
  private items: FeedbackItem[] = [];
  private nextId = 1;

  add(item: NewFeedbackItem, at = Date.now()): FeedbackItem {
    const added: FeedbackItem = { ...item, id: this.nextId++, createdAt: at };
    this.items.push(added);
    this.emit("change");
    return added;
  }

  remove(id: number): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) this.emit("change");
  }

  /** A session's queued items, oldest first. */
  listFor(token: string): FeedbackItem[] {
    return this.items.filter((item) => item.token === token);
  }

  /** Items on one file, for Split Diff's "N comments queued" note. */
  listForFile(filePath: string): FeedbackItem[] {
    return this.items.filter((item) => item.filePath === filePath);
  }

  clear(token: string): void {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.token !== token);
    if (this.items.length !== before) this.emit("change");
  }
}
