/** Long enough for one `claude` to get through its startup before the next
 *  begins, short enough that a handful of terminals are all back within
 *  seconds. */
const RESUME_SPACING_MS = 1500;

/**
 * Multi-agent loads every terminal at startup (GroupController's
 * loadDeferredTerminals), so a restart with sessions in several terminals
 * would start that many `claude --resume` at the same moment. This runs
 * them one after another instead, the first at once.
 */
export class ResumeQueue {
  private nextAt = 0;
  private timers = new Set<number>();

  run(start: () => void): void {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + RESUME_SPACING_MS;
    if (at === now) {
      start();
      return;
    }
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      start();
    }, at - now);
    this.timers.add(timer);
  }

  dispose(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
  }
}
