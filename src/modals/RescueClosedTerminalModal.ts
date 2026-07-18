import { App, FuzzySuggestModal } from "obsidian";
import { ClosedTerminalEntry } from "../state/ClosedTerminalBuffer";

function formatRelativeTime(timestampMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/** Command-palette-triggered (no ribbon click, so no MouseEvent to anchor a
 *  Menu to like the terminal-placement picker uses) -- a fuzzy suggester is
 *  the idiomatic Obsidian pattern for choosing among a list this way. */
export class RescueClosedTerminalModal extends FuzzySuggestModal<ClosedTerminalEntry> {
  constructor(app: App, private entries: ClosedTerminalEntry[], private onChoose: (entry: ClosedTerminalEntry) => void) {
    super(app);
    this.setPlaceholder("Choose a closed terminal to rescue...");
  }

  getItems(): ClosedTerminalEntry[] {
    return this.entries;
  }

  getItemText(entry: ClosedTerminalEntry): string {
    return `${entry.displayText} — closed ${formatRelativeTime(entry.closedAt)}`;
  }

  onChooseItem(entry: ClosedTerminalEntry): void {
    this.onChoose(entry);
  }
}
