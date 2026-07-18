export interface ClosedTerminalEntry {
  displayText: string;
  scrollback: string;
  cwd: string | null;
  customName: string | null;
  color: string | null;
  closedAt: number;
}

const MAX_CLOSED_TERMINALS = 10;

/**
 * Plugin-wide ring buffer of recently closed terminals, in-memory only (not
 * persisted across Obsidian restarts -- TerminalView's own getState/setState
 * already handles the restart case; this is for "I closed a tab a minute
 * ago", a live-session accident, not a relaunch).
 */
export class ClosedTerminalBuffer {
  private entries: ClosedTerminalEntry[] = [];

  push(entry: ClosedTerminalEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_CLOSED_TERMINALS) this.entries.pop();
  }

  list(): ClosedTerminalEntry[] {
    return [...this.entries];
  }

  /** Once rescued, an entry is a live terminal again, not a closed one --
   *  removed by reference rather than a snapshot index, since the entry
   *  object a caller holds (e.g. from a modal opened earlier) is always
   *  identity-comparable against whatever's currently in the buffer. */
  remove(entry: ClosedTerminalEntry): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) this.entries.splice(index, 1);
  }
}
