import { ItemView, Notice, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { IDecoration, Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { pathJoin, pathRelative, randomHex } from "../node/fs";
import { getAllEnvVars } from "../node/process";
import { PtyProcess } from "../pty/PtyProcess";
import { getShellIntegrationEnv } from "../pty/shellIntegration";
import { buildDiff } from "../server/diff";
import { detectBacklinkBreakage } from "../backlinks/breakage";
import { CommandTracker, TrackedCommand } from "../terminal/CommandTracker";
import { CommandHelpModal } from "../modals/CommandHelpModal";
import { PreToolUseHookPayload } from "../hooks/types";
import { errorMessage } from "../util/errors";
import type TerminusPlugin from "../main";

export const TERMINUS_VIEW_TYPE = "terminus-view";

// Caps how much scrollback gets written into workspace.json on save/restore
// -- generous enough to feel continuous across an Obsidian restart, bounded
// enough not to bloat the workspace layout file.
const SCROLLBACK_PERSIST_LINES = 1000;

/**
 * xterm.js measures character cell width via Canvas 2D's `context.font`,
 * which cannot resolve a CSS custom property like "var(--font-monospace)" --
 * it silently falls back to a mismeasured default, producing the "odd
 * spacing between letters" symptom. Resolve Obsidian's actual configured
 * monospace font to a literal string at runtime instead.
 */
function resolveMonospaceFontStack(): string {
  const resolved = getComputedStyle(activeDocument.body).getPropertyValue("--font-monospace").trim();
  const fallback = "Menlo, Monaco, Consolas, monospace";
  return resolved ? `${resolved}, ${fallback}` : fallback;
}

export class TerminalView extends ItemView {
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private serializeAddon: SerializeAddon | null = null;
  private pty: PtyProcess | null = null;
  private commandTracker: CommandTracker | null = null;
  private readonly failureBadges = new Map<number, IDecoration>();
  private readonly token: string;
  private restoredScrollback: string | null = null;
  private scrollbackApplied = false;
  // Assigned eagerly in the constructor (not onOpen) since getDisplayText()
  // can be called by Obsidian before onOpen runs (e.g. restoring tab titles
  // from the saved workspace layout). Resets each session -- not persisted
  // across Obsidian restarts, purely a within-session display identity, not
  // tied to the hook/review token (which is what actually keeps concurrent
  // terminals' PreToolUse traffic correctly isolated).
  private readonly terminalNumber: number;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
    this.token = randomHex(16);
    this.terminalNumber = plugin.allocateTerminalNumber();
  }

  getViewType(): string {
    return TERMINUS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return `Terminus ${this.terminalNumber}`;
  }

  getIcon(): string {
    return "square-terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("terminus-view");
    const xtermContainer = container.createDiv({ cls: "terminus-xterm-container" });

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: this.plugin.settings.fontSize,
      fontFamily: resolveMonospaceFontStack(),
      allowProposedApi: true,
    });
    this.fitAddon = new FitAddon();
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.serializeAddon);
    this.term.open(xtermContainer);
    this.fitAddon.fit();

    this.applyRestoredScrollbackIfPending();

    this.commandTracker = new CommandTracker(this.term, (cmd) => this.handleCommandFinished(cmd));

    this.plugin.reviewServer.register(this.token, {
      onChangeApplied: (payload) => this.onChangeApplied(payload),
    });

    await this.startPty();

    this.term.onData((data) => this.pty?.write(data));
    this.term.onResize(({ cols, rows }) => this.pty?.resize(cols, rows));

    // Obsidian's own ItemView.onResize() only fires for layout changes it
    // recognizes as a leaf resize (e.g. a full window resize) -- it's not
    // reliable for every actual size change of this container (sidebar
    // toggles, other panels opening/closing, etc.), which lets the PTY's
    // idea of cols/rows silently drift from what's really on screen. A
    // ResizeObserver watches the container element itself, so it catches
    // every real size change regardless of cause.
    this.resizeObserver = new ResizeObserver(() => this.fitAddon?.fit());
    this.resizeObserver.observe(xtermContainer);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.plugin.reviewServer.unregister(this.token);
    this.pty?.kill();
    this.commandTracker?.dispose();
    for (const decoration of this.failureBadges.values()) decoration.dispose();
    this.failureBadges.clear();
    this.term?.dispose();
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      scrollback: this.serializeAddon?.serialize({ scrollback: SCROLLBACK_PERSIST_LINES }) ?? "",
    };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const scrollback = (state as { scrollback?: unknown } | null)?.scrollback;
    if (typeof scrollback === "string" && scrollback.length > 0) {
      if (this.term) {
        this.writeRestoredScrollback(scrollback);
      } else {
        // Terminal isn't constructed yet -- onOpen hasn't run, or hasn't
        // reached this point yet. Stash it; onOpen applies it once ready.
        this.restoredScrollback = scrollback;
      }
    }
    await super.setState(state, result);
  }

  private applyRestoredScrollbackIfPending(): void {
    if (this.restoredScrollback) {
      this.writeRestoredScrollback(this.restoredScrollback);
      this.restoredScrollback = null;
    }
  }

  private writeRestoredScrollback(scrollback: string): void {
    if (this.scrollbackApplied || !this.term) return;
    this.scrollbackApplied = true;
    this.term.write(scrollback);
    // The restored buffer is from a shell process that no longer exists --
    // a fresh PTY is about to start. Mark the boundary so old output isn't
    // mistaken for continuing live output.
    this.term.write("\r\n\x1b[90m─── restored from previous session ───\x1b[0m\r\n");
  }

  applyFontSize(size: number): void {
    if (!this.term) return;
    this.term.options.fontSize = size;
    // Changing font size changes character cell metrics, so the terminal's
    // cols/rows need re-fitting -- and the PTY needs to know, or the shell's
    // idea of the window size will be stale (wrapping in the wrong place).
    this.fitAddon?.fit();
    this.pty?.resize(this.term.cols, this.term.rows);
  }

  onResize(): void {
    this.fitAddon?.fit();
  }

  private async startPty(): Promise<void> {
    const pythonBin = await this.plugin.getPython3Bin();
    const shell = this.plugin.getUserShell();
    const resourcesDir = pathJoin(this.plugin.getPluginDir(), "resources");
    const helperPath = pathJoin(resourcesDir, "pty_helper.py");
    const port = this.plugin.reviewServer.getPort();

    this.pty = new PtyProcess({
      pythonBin,
      helperPath,
      shell,
      cwd: this.plugin.getVaultBasePath(),
      cols: this.term?.cols ?? 80,
      rows: this.term?.rows ?? 24,
      env: {
        ...getAllEnvVars(),
        TERM: "xterm-256color",
        TERMINUS_HOOK_PORT: String(port),
        TERMINUS_HOOK_TOKEN: this.token,
        ...getShellIntegrationEnv(shell, resourcesDir),
      },
    });

    this.pty.on("data", (chunk: Buffer) => this.term?.write(chunk.toString("utf8")));
    this.pty.on("stderr", (text: string) => new Notice(`Terminus: ${text.trim()}`));
    this.pty.on("error", (err) => new Notice(`Terminus: PTY error: ${errorMessage(err)}`));
    this.pty.on("exit", ({ code }: { code: number | null }) => {
      this.term?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ""}]\r\n`);
    });

    this.pty.start();
  }

  /** Renders a small clickable badge next to a command that exited
   *  non-zero, anchored to a marker (so it stays correctly positioned as
   *  the buffer scrolls) at that command's own row -- see CommandTracker's
   *  MARKER_ROW_OFFSET for why that's the *start* marker, not a raw row
   *  number. exitCode === null means the shell-integration hook never fired
   *  a D for it (e.g. Ctrl-C'd) -- nothing to flag either way.
   *
   *  Positioned right after the row's actual visible text (not pinned to
   *  the terminal's right edge): xterm.js decorations overlay the cell
   *  grid rather than reserving space, so a fixed right-edge position
   *  would sit on top of the command text itself whenever the line runs
   *  long enough to reach it. Reading the row's real content length and
   *  placing the badge just past it keeps it in space that's guaranteed
   *  blank. */
  private handleCommandFinished(cmd: TrackedCommand): void {
    if (!this.term || !cmd.exitCode) return;

    const line = this.term.buffer.active.getLine(cmd.startMarker.line);
    const contentLength = line ? line.translateToString(true).length : 0;
    const x = Math.min(contentLength + 1, Math.max(this.term.cols - 1, 0));

    const decoration = this.term.registerDecoration({
      marker: cmd.startMarker,
      anchor: "left",
      x,
      width: 1,
    });
    if (!decoration) return;

    this.failureBadges.set(cmd.id, decoration);
    decoration.onDispose(() => this.failureBadges.delete(cmd.id));

    // onRender is an event, not a one-time callback -- it fires again on
    // every scroll/resize/repaint of this decoration's row, reusing the
    // same underlying element each time. Without this guard, every firing
    // would attach another click listener on top of the previous ones, so
    // a single real click would fire the handler (and open the modal) once
    // per accumulated listener -- exactly the multiple-stacked-modal bug
    // this fixes.
    let listenerBound = false;
    decoration.onRender((el) => {
      el.addClass("terminus-failure-badge");
      el.setAttr("title", `Command exited with code ${cmd.exitCode} -- click for help`);
      el.textContent = "⚠";
      if (!listenerBound) {
        listenerBound = true;
        el.addEventListener("click", () => void this.onFailureBadgeClick(cmd));
      }
    });
  }

  private async onFailureBadgeClick(cmd: TrackedCommand): Promise<void> {
    // Includes a few preceding commands, not just this one -- e.g. a
    // failed `git push` at the end of `git init` / `git add` / `git
    // commit` / `git push` needs that earlier context to get a useful
    // suggestion, since the fix might be "you never committed" rather than
    // anything about push itself.
    const transcript = this.commandTracker?.getRecentContext(cmd) ?? "";
    const claudeBin = await this.plugin.getClaudeBin();
    new CommandHelpModal(this.app, claudeBin, this.plugin.getVaultBasePath(), cmd.exitCode ?? 0, transcript, (command) => {
      // Populates the terminal's input line without submitting it -- the
      // user reviews/edits and presses Enter themselves, same principle as
      // the rest of this plugin (Claude proposes, a human confirms before
      // anything actually happens).
      this.pty?.write(command);
      // The modal closing reveals the terminal again, but with multiple
      // terminals now supported it may not be obvious *which* one just got
      // the command -- name it explicitly rather than relying on the user
      // noticing.
      new Notice(`Terminus: suggested command added to ${this.getDisplayText()} — press Enter to run it`);
    }).open();
  }

  /**
   * Fires from the PreToolUse hook right before Claude's own Edit/Write
   * executes -- the write is NOT gated on this, it's allowed to proceed
   * immediately so a whole multi-edit turn completes uninterrupted. This
   * just records the pre-edit snapshot for later review/revert.
   */
  private async onChangeApplied(payload: PreToolUseHookPayload): Promise<void> {
    const diff = await buildDiff(payload);
    this.plugin.pendingChangesStore.recordChange({
      payload,
      diff,
      panelLabel: this.getDisplayText(),
    });
    // Doesn't reveal/focus the panel directly here -- Claude may make
    // several edits in one turn, and popping the sidebar open on each one
    // would be distracting mid-turn. Instead PendingChangesStore's
    // "recorded" event is debounced centrally in main.ts, so the panel
    // comes to front once, shortly after the last edit in a burst settles.

    void this.checkBacklinkBreakage(diff.filePath);
  }

  /** Runs after recordChange so a slow scan never delays the write itself
   *  (already happened by this point) -- uses the merged, coalesced diff
   *  (first oldText vs latest newText) so a multi-edit turn is checked as a
   *  whole, not edit-by-edit. */
  private async checkBacklinkBreakage(absoluteFilePath: string): Promise<void> {
    const relPath = pathRelative(this.plugin.getVaultBasePath(), absoluteFilePath);
    const file = this.app.vault.getAbstractFileByPath(relPath);
    if (!(file instanceof TFile)) return;

    const merged = this.plugin.pendingChangesStore.get(absoluteFilePath);
    if (!merged) return; // already resolved before this ran

    const broken = detectBacklinkBreakage(this.app, file, merged.diff.oldText, merged.diff.newText);
    this.plugin.pendingChangesStore.setBrokenBacklinks(absoluteFilePath, broken);
  }
}
