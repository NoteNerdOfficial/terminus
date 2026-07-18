import { IMarker, Terminal } from "@xterm/xterm";
import { registerOscHandlerSafe } from "./oscHandler";

export interface TrackedCommand {
  id: number;
  startMarker: IMarker;
  endMarker: IMarker | null;
  exitCode: number | null;
}

const MAX_TRACKED_COMMANDS = 50;

/**
 * When a C or D marker fires, the cursor has already advanced (via the
 * \r\n after Enter) to a fresh row that's about to be reused: the *next*
 * prompt gets redrawn in-place on that same row (zsh's PROMPT_EOL_MARK
 * erase-and-redraw dance, or bash's PROMPT_COMMAND simply continuing from
 * the cursor's current position) rather than a forced newline first. So
 * the content actually associated with a marker event -- the command's own
 * echoed text at C, or trailing output at D -- lives one row *above* where
 * the cursor sits when the marker fires, not on it. Verified empirically
 * against real captured zsh and bash PTY output, not assumed: without this
 * offset, a command's tracked bracket ends up capturing the *next*
 * command's prompt/typed text instead of its own.
 */
const MARKER_ROW_OFFSET = -1;

/**
 * Tracks command boundaries and exit codes using the OSC 133 markers
 * emitted by resources/shell-integration/{zsh,bash} (C = command about to
 * run, D;<code> = command finished with exit code <code>). Registers
 * xterm.js markers (which track a logical row and stay correct across
 * scrolling/reflow) rather than raw row numbers, so command output can
 * still be read back later even after more output has scrolled the buffer.
 */
export class CommandTracker {
  private commands: TrackedCommand[] = [];
  private current: TrackedCommand | null = null;
  private nextId = 1;
  private oscHandler: { dispose(): void };
  // Anchor for the very first tracked command, in case IT is multi-line --
  // registered immediately at construction (before any command has run),
  // so it marks wherever the terminal's content began.
  private readonly sessionStartMarker: IMarker;

  constructor(private term: Terminal, private onCommandFinished: (cmd: TrackedCommand) => void) {
    this.sessionStartMarker = term.registerMarker(0);
    this.oscHandler = registerOscHandlerSafe(term, 133, (data) => this.handleOsc133(data));
  }

  dispose(): void {
    this.oscHandler.dispose();
    this.sessionStartMarker.dispose();
    for (const cmd of this.commands) {
      cmd.startMarker.dispose();
      cmd.endMarker?.dispose();
    }
  }

  getCommands(): TrackedCommand[] {
    return [...this.commands];
  }

  /** Like getCommandOutput, but includes up to `maxPrecedingCommands`
   *  commands run right before this one -- useful when the failure is the
   *  last step of a short sequence (e.g. `git init`, `git add`, `git
   *  commit`, `git push`, where the push fails because an earlier step in
   *  that sequence was skipped or went wrong) and the single failed
   *  command's own output alone doesn't carry that context. Each
   *  command's rows are already contiguous in the real terminal buffer, so
   *  joining them reconstructs a natural chronological transcript. */
  getRecentContext(cmd: TrackedCommand, maxPrecedingCommands = 3): string {
    const idx = this.commands.indexOf(cmd);
    if (idx === -1) return this.getCommandOutput(cmd);

    const start = Math.max(0, idx - maxPrecedingCommands);
    return this.commands
      .slice(start, idx + 1)
      .map((c) => this.getCommandOutput(c))
      .join("\n");
  }

  /** Reads the terminal's live buffer between the command's start/end
   *  markers -- markers, not stored row numbers, so this stays correct even
   *  after the buffer has scrolled since the command ran. Caps the end at
   *  the *next* tracked command's start row rather than trusting the D
   *  marker's own row: in real shell output there's prompt-redraw content
   *  between a command's D marker and the next C (not necessarily a clean
   *  newline right at D), and capping against the next command's start is
   *  the only boundary that reliably excludes it. */
  getCommandOutput(cmd: TrackedCommand): string {
    const startLine = cmd.startMarker.line;
    let endLine = cmd.endMarker?.line ?? -1;
    if (startLine < 0) return "";

    const idx = this.commands.indexOf(cmd);
    const next = idx >= 0 ? this.commands[idx + 1] : undefined;
    if (next && next.startMarker.line >= 0) {
      endLine = endLine >= 0 ? Math.min(endLine, next.startMarker.line - 1) : next.startMarker.line - 1;
    }
    if (endLine < startLine) return "";

    const lines: string[] = [];
    for (let y = startLine; y <= endLine; y++) {
      const line = this.term.buffer.active.getLine(y);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n");
  }

  private handleOsc133(data: string): boolean {
    const [kind, arg] = data.split(";");

    if (kind === "C") {
      // MARKER_ROW_OFFSET (-1) only recovers the single row right before
      // this event -- correct for a normal one-line command, but a
      // backslash-continued or heredoc command spans several rows before
      // Enter is finally pressed and C fires, and -1 would only capture
      // its last line (verified empirically: a 3-line continued command
      // was silently truncated to just the third line). Anchoring to
      // "right after the previous command's own end" instead spans the
      // full gap, covering however many rows this command's input
      // actually took. For the very first tracked command there's no
      // previous command's end to be "right after" -- sessionStartMarker
      // is used as-is (no +1), since it already marks the true beginning,
      // not the tail end of something else.
      const prev = this.commands[this.commands.length - 1];
      let startMarker: IMarker;
      if (prev?.endMarker && prev.endMarker.line >= 0) {
        startMarker = this.registerMarkerAtRow(prev.endMarker.line + 1);
      } else if (this.sessionStartMarker.line >= 0) {
        startMarker = this.registerMarkerAtRow(this.sessionStartMarker.line);
      } else {
        startMarker = this.term.registerMarker(MARKER_ROW_OFFSET);
      }

      this.current = {
        id: this.nextId++,
        startMarker,
        endMarker: null,
        exitCode: null,
      };
      return true;
    }

    if (kind === "D" && this.current) {
      this.current.endMarker = this.term.registerMarker(MARKER_ROW_OFFSET);
      this.current.exitCode = arg !== undefined && arg !== "" ? parseInt(arg, 10) : null;
      this.commands.push(this.current);
      if (this.commands.length > MAX_TRACKED_COMMANDS) {
        const removed = this.commands.shift();
        removed?.startMarker.dispose();
        removed?.endMarker?.dispose();
      }
      this.onCommandFinished(this.current);
      this.current = null;
      return true;
    }

    return false;
  }

  /** registerMarker() only takes an offset relative to the CURRENT cursor
   *  position, not an absolute row -- this converts an absolute target row
   *  into that offset using baseY (scrollback offset) + cursorY (viewport
   *  offset), which together give the cursor's absolute row. */
  private registerMarkerAtRow(targetRow: number): IMarker {
    const buffer = this.term.buffer.active;
    const currentAbsoluteRow = buffer.baseY + buffer.cursorY;
    return this.term.registerMarker(targetRow - currentAbsoluteRow);
  }
}
