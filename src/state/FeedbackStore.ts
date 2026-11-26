import { TypedEmitter } from "../node/emitter";
import type { ReviewIntent } from "../browser/review";

/** One comment on a hunk, or on text selected in a note, queued until it's
 *  sent to the session. */
export interface FeedbackItem {
  id: number;
  /** The terminal whose session gets it: the one that made the change. */
  token: string;
  /** That terminal's name when the comment was made, for a card whose
   *  terminal has since closed. */
  terminalLabel: string;
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
  /** Set for a comment on text selected in a note (see review/noteReview.ts):
   *  what the user wants done with it. A hunk comment has none. */
  intent?: ReviewIntent;
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

  /**
   * Changes a queued comment's text, and its type for one on note text.
   * Emptying a comment that needs words removes it, as emptying a queued
   * message does; a Keep needs none.
   */
  edit(id: number, comment: string, intent?: ReviewIntent): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    const text = comment.trim();
    const nextIntent = item.intent && intent ? intent : item.intent;
    if (!text && nextIntent !== "keep") {
      this.remove(id);
      return;
    }
    if (item.comment === text && item.intent === nextIntent) return;
    this.items = this.items.map((entry) => (entry.id === id ? { ...entry, comment: text, intent: nextIntent } : entry));
    this.emit("change");
  }

  /** Moves a comment to sit before `beforeId` among its session's, or to
   *  the end of them when null: the order they're numbered in when sent. */
  move(token: string, id: number, beforeId: number | null): void {
    const mine = this.listFor(token);
    const moving = mine.find((item) => item.id === id);
    if (!moving || id === beforeId) return;
    const rest = mine.filter((item) => item.id !== id);
    const at = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
    rest.splice(at === -1 ? rest.length : at, 0, moving);
    if (rest.every((item, i) => item === mine[i])) return;
    // Other sessions' comments keep their places; this session's take the new order.
    let next = 0;
    this.items = this.items.map((item) => (item.token === token ? rest[next++]! : item));
    this.emit("change");
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

  /** Every session with something queued. */
  tokens(): Set<string> {
    return new Set(this.items.map((item) => item.token));
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
