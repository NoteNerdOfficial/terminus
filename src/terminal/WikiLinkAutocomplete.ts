import { App, TFile, prepareFuzzySearch } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { pathJoin } from "terminus-node-bridge";
import { WikiLinkInsertFormat } from "../settings";

const MAX_SUGGESTIONS = 8;

export interface WikiLinkAutocompleteOptions {
  app: App;
  term: Terminal;
  xtermContainer: HTMLElement;
  getVaultBasePath: () => string;
  getInsertFormat: () => WikiLinkInsertFormat;
  /** Writes the finally-resolved link/path text to the pty. */
  onInsert: (text: string) => void;
  /** Writes raw bytes to the pty exactly as if this class weren't
   *  intercepting anything -- used to flush a held "[" that turned out not
   *  to start a "[[", and to forward everything typed so far when the
   *  picker is cancelled. */
  onPassthrough: (text: string) => void;
}

/**
 * Detects `[[` typed interactively in the terminal and offers a fuzzy
 * vault-note picker instead of forwarding those keystrokes to the shell.
 *
 * Unlike a text editor, a real terminal has no local echo -- every
 * character the user sees on screen is an echo from the *remote* shell's
 * own readline. So this can't react to "already displayed" text; it has to
 * intercept `[[` before it's ever written to the pty (see handleData),
 * and forward a resolved replacement only once the user actually confirms
 * a choice.
 */
export class WikiLinkAutocomplete {
  // True once a lone "[" has been swallowed but not yet forwarded, waiting
  // to see if the very next keystroke is also "[".
  private pendingBracket = false;
  private active = false;
  private query = "";
  private selectedIndex = 0;
  private matches: TFile[] = [];
  private popoverEl: HTMLElement | null = null;

  constructor(private opts: WikiLinkAutocompleteOptions) {}

  /** Called from term.onData in place of a direct pty.write -- consumes
   *  the data itself (writing to the pty only via opts.onInsert/
   *  onPassthrough) rather than returning a pass/fail flag, since every
   *  path already knows exactly what (if anything) should reach the pty. */
  handleData(data: string): void {
    if (this.active) {
      this.handleActiveKey(data);
      return;
    }

    // Only a single real keystroke arms the "[[" detector -- a paste (or
    // any other multi-char chunk) already contains its final intended
    // text, so it's forwarded untouched rather than possibly triggering
    // the picker mid-paste.
    if (data.length !== 1) {
      this.flushPendingBracket();
      this.opts.onPassthrough(data);
      return;
    }

    if (this.pendingBracket) {
      this.pendingBracket = false;
      if (data === "[") {
        this.open();
        return;
      }
      this.opts.onPassthrough("[");
      // Falls through -- `data` itself still needs normal handling below
      // (e.g. it could be the "[" that starts a fresh pair).
    }

    if (data === "[") {
      this.pendingBracket = true;
      return;
    }

    this.opts.onPassthrough(data);
  }

  dispose(): void {
    this.closePopover();
  }

  private flushPendingBracket(): void {
    if (!this.pendingBracket) return;
    this.pendingBracket = false;
    this.opts.onPassthrough("[");
  }

  private open(): void {
    this.active = true;
    this.query = "";
    this.selectedIndex = 0;
    this.updateMatches();
    this.renderPopover();
  }

  private handleActiveKey(data: string): void {
    if (data === "\r") {
      this.confirmSelection();
      return;
    }
    if (data === "\x1b") {
      this.cancel();
      return;
    }
    if (data === "\x1b[A") {
      this.moveSelection(-1);
      return;
    }
    if (data === "\x1b[B") {
      this.moveSelection(1);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.query.length === 0) {
        this.cancel();
        return;
      }
      this.query = this.query.slice(0, -1);
      this.updateMatches();
      this.renderPopover();
      return;
    }
    // Any other single printable character extends the query; anything
    // else (unrecognized control/escape sequences) is silently ignored
    // rather than guessed at.
    if (data.length === 1 && data >= " ") {
      this.query += data;
      this.updateMatches();
      this.renderPopover();
    }
  }

  private updateMatches(): void {
    const files = this.opts.app.vault.getMarkdownFiles();
    if (!this.query) {
      this.matches = files.slice(0, MAX_SUGGESTIONS);
      return;
    }
    const search = prepareFuzzySearch(this.query);
    this.matches = files
      .map((file) => ({ file, result: search(file.basename) }))
      .filter((m): m is { file: TFile; result: NonNullable<ReturnType<typeof search>> } => m.result !== null)
      .sort((a, b) => b.result.score - a.result.score)
      .slice(0, MAX_SUGGESTIONS)
      .map((m) => m.file);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(this.matches.length - 1, 0));
  }

  private moveSelection(delta: number): void {
    if (this.matches.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.matches.length) % this.matches.length;
    this.renderPopover();
  }

  private confirmSelection(): void {
    const file = this.matches[this.selectedIndex];
    this.closePopover();
    this.active = false;
    if (!file) return;
    this.opts.onInsert(this.resolveInsertText(file));
  }

  private cancel(): void {
    this.closePopover();
    this.active = false;
    // Reproduces exactly what would have reached the pty if this class had
    // never intercepted anything -- the opening "[[" plus whatever query
    // text was typed since.
    this.opts.onPassthrough(`[[${this.query}`);
    this.query = "";
  }

  private resolveInsertText(file: TFile): string {
    const format = this.opts.getInsertFormat();
    if (format === "vault-relative") return file.path;
    if (format === "absolute") return pathJoin(this.opts.getVaultBasePath(), file.path);
    return `[[${this.opts.app.metadataCache.fileToLinktext(file, "", true)}]]`;
  }

  private renderPopover(): void {
    this.closePopover();

    const rect = this.opts.xtermContainer.getBoundingClientRect();
    const cellWidth = rect.width / Math.max(this.opts.term.cols, 1);
    const cellHeight = rect.height / Math.max(this.opts.term.rows, 1);
    const cursorX = this.opts.term.buffer.active.cursorX;
    const cursorY = this.opts.term.buffer.active.cursorY;

    const popover = this.opts.xtermContainer.ownerDocument.createElement("div");
    popover.addClass("terminus-wikilink-popover");
    popover.style.left = `${rect.left + cursorX * cellWidth}px`;
    popover.style.top = `${rect.top + (cursorY + 1) * cellHeight}px`;

    if (this.matches.length === 0) {
      popover.createDiv({ cls: "terminus-wikilink-item terminus-wikilink-empty", text: "No matching notes" });
    } else {
      this.matches.forEach((file, index) => {
        const item = popover.createDiv({ cls: "terminus-wikilink-item", text: file.basename });
        if (index === this.selectedIndex) item.addClass("is-selected");
      });
    }

    this.opts.xtermContainer.ownerDocument.body.appendChild(popover);
    this.popoverEl = popover;
  }

  private closePopover(): void {
    this.popoverEl?.remove();
    this.popoverEl = null;
  }
}
