/**
 * Minimal typed event emitter, used instead of Node's `events.EventEmitter`.
 * `class X extends EventEmitter` puts every consumer of X on the hook for
 * whatever Node's ambient `events` module type resolves to in whatever
 * environment is type-checking this code; composing over a small local
 * class with an explicit per-event payload map avoids that entirely -- this
 * file has zero Node imports.
 */
type AnyListener = (...args: unknown[]) => void;

export class TypedEmitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AnyListener);
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
    this.listeners.get(event)?.delete(listener as AnyListener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) listener(...args);
  }
}
