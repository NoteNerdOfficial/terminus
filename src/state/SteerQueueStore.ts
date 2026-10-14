import { TypedEmitter } from "../node/emitter";

/** One message waiting to be sent to a session once its turn ends. */
export interface QueuedMessage {
  id: number;
  text: string;
}

type SteerQueueEvents = {
  change: [];
};

/**
 * Messages queued per session ("Queue" in the Agent inbox's "Tell this
 * session…" box), in order. Held here rather than in Claude Code, which only
 * folds mid-turn input into the running turn: this is what lets them be
 * edited, reordered, promoted to a steer, and sent one turn at a time.
 *
 * The terminal's token doesn't outlive Obsidian, so each TerminalView saves
 * its own queue in its state (see `texts` and `restore`). A restored queue
 * starts paused: the turn it was waiting for is gone, and sending on its own
 * right after a restart would surprise.
 */
export class SteerQueueStore extends TypedEmitter<SteerQueueEvents> {
  private queues = new Map<string, QueuedMessage[]>();
  private paused = new Set<string>();
  private nextId = 1;

  listFor(token: string): QueuedMessage[] {
    return this.queues.get(token) ?? [];
  }

  /** Every session with something queued. */
  tokens(): string[] {
    return [...this.queues.keys()];
  }

  isPaused(token: string): boolean {
    return this.paused.has(token);
  }

  add(token: string, text: string): QueuedMessage | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const item = { id: this.nextId++, text: trimmed };
    this.queues.set(token, [...this.listFor(token), item]);
    this.emit("change");
    return item;
  }

  edit(token: string, id: number, text: string): void {
    const trimmed = text.trim();
    const items = this.listFor(token);
    const at = items.findIndex((item) => item.id === id);
    if (at === -1) return;
    if (!trimmed) {
      this.remove(token, id);
      return;
    }
    if (items[at]!.text === trimmed) return;
    this.set(token, items.map((item) => (item.id === id ? { ...item, text: trimmed } : item)));
  }

  /** Moves an item to sit before `beforeId`, or to the end when null. */
  move(token: string, id: number, beforeId: number | null): void {
    const items = this.listFor(token);
    const moving = items.find((item) => item.id === id);
    if (!moving || id === beforeId) return;
    const rest = items.filter((item) => item.id !== id);
    const at = beforeId === null ? rest.length : rest.findIndex((item) => item.id === beforeId);
    rest.splice(at === -1 ? rest.length : at, 0, moving);
    if (rest.every((item, i) => item === items[i])) return;
    this.set(token, rest);
  }

  remove(token: string, id: number): void {
    const items = this.listFor(token);
    if (!items.some((item) => item.id === id)) return;
    this.set(token, items.filter((item) => item.id !== id));
  }

  /** Takes the first item off, for sending. */
  shift(token: string): QueuedMessage | undefined {
    const [first, ...rest] = this.listFor(token);
    if (!first) return undefined;
    this.set(token, rest);
    return first;
  }

  clear(token: string): void {
    if (!this.queues.has(token) && !this.paused.has(token)) return;
    this.set(token, []);
  }

  pause(token: string): void {
    if (this.paused.has(token)) return;
    this.paused.add(token);
    this.emit("change");
  }

  resume(token: string): void {
    if (!this.paused.delete(token)) return;
    this.emit("change");
  }

  /** What a terminal saves in its state. */
  texts(token: string): string[] {
    return this.listFor(token).map((item) => item.text);
  }

  /** A restored terminal's saved queue, paused. Silent: nothing to save. */
  restore(token: string, texts: string[]): void {
    const items = texts.filter((text) => text.trim()).map((text) => ({ id: this.nextId++, text }));
    if (items.length === 0) return;
    this.queues.set(token, items);
    this.paused.add(token);
    this.emit("change");
  }

  /** The terminal closed. */
  forget(token: string): void {
    this.queues.delete(token);
    this.paused.delete(token);
  }

  private set(token: string, items: QueuedMessage[]): void {
    if (items.length === 0) {
      this.queues.delete(token);
      this.paused.delete(token);
    } else {
      this.queues.set(token, items);
    }
    this.emit("change");
  }
}
