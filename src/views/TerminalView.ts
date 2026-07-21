import { ItemView, Notice, Platform, TFile, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { IDecoration, ITheme, Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { pathJoin, pathRelative, randomHex, getAllEnvVars, bufferToString, fileExistsSync } from "terminus-node-bridge";
import { PtyProcess } from "../pty/PtyProcess";
import { getShellIntegrationEnv } from "../pty/shellIntegration";
import { buildDiff } from "../server/diff";
import { detectBacklinkBreakage } from "../backlinks/breakage";
import { CommandTracker, TrackedCommand } from "../terminal/CommandTracker";
import { CwdTracker } from "../terminal/CwdTracker";
import { WikiLinkAutocomplete } from "../terminal/WikiLinkAutocomplete";
import { openTerminalColorPicker } from "../terminal/TerminalColorPicker";
import { refreshTabHeader, refreshPaneTitle } from "../terminal/tabHeaderColor";
import { CommandHelpModal } from "../modals/CommandHelpModal";
import { RenameTerminalModal } from "../modals/RenameTerminalModal";
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

/**
 * Same rationale as resolveMonospaceFontStack(): xterm's `theme` option
 * needs literal color strings, not CSS custom properties, so Obsidian's
 * computed theme variables are read once (and re-read on Obsidian's own
 * "css-change" event) rather than passed through as var(...) references.
 */
/** Wraps a path in single quotes for safe insertion into a shell input
 *  line, escaping any embedded single quotes with the standard '\'' trick.
 *  Only bothers quoting when the path actually needs it (contains a space
 *  or a shell-meaningful character) -- a plain path stays unquoted so it
 *  reads naturally for the common case. */
function shellQuoteIfNeeded(path: string): string {
  if (!/[\s'"$`\\!*?[\](){}<>|;&~]/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** A dropped OS file's absolute path used to be readable straight off
 *  `File.path` -- Electron deprecated and then (Electron 32, bundled since
 *  Obsidian 1.7ish) removed it, requiring `webUtils.getPathForFile()`
 *  instead (verified empirically: Obsidian's own paste/drop handling in
 *  app.js already switched to it). Falls back to the old property for
 *  older Electron builds, since both have shipped in the wild. */
function getOsFilePath(file: File): string | undefined {
  if (!Platform.isDesktopApp) return undefined;
  try {
    const { webUtils } = require("electron") as { webUtils?: { getPathForFile(file: File): string } };
    const path = webUtils?.getPathForFile(file);
    if (path) return path;
  } catch {
    // require("electron") unavailable in this context -- fall through.
  }
  return (file as File & { path?: string }).path;
}

function resolveXtermTheme(): ITheme {
  const style = getComputedStyle(activeDocument.body);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--background-primary", "#1e1e1e"),
    foreground: v("--text-normal", "#dcdcdc"),
    cursor: v("--text-accent", v("--interactive-accent", "#dcdcdc")),
    selectionBackground: v("--text-selection", "#3a3d41"),
  };
}

export class TerminalView extends ItemView {
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private serializeAddon: SerializeAddon | null = null;
  private pty: PtyProcess | null = null;
  private commandTracker: CommandTracker | null = null;
  private cwdTracker: CwdTracker | null = null;
  private wikiLinkAutocomplete: WikiLinkAutocomplete | null = null;
  private readonly failureBadges = new Map<number, IDecoration>();
  private readonly token: string;
  private restoredScrollback: string | null = null;
  private scrollbackApplied = false;
  // The cwd a restored terminal should start its fresh shell in -- read
  // once in setState (before onOpen/startPty run), consumed by startPty().
  private restoredCwd: string | null = null;
  // Assigned eagerly in the constructor (not onOpen) since getDisplayText()
  // can be called by Obsidian before onOpen runs (e.g. restoring tab titles
  // from the saved workspace layout). Resets each session -- not persisted
  // across Obsidian restarts, purely a within-session display identity, not
  // tied to the hook/review token (which is what actually keeps concurrent
  // terminals' PreToolUse traffic correctly isolated).
  private readonly terminalNumber: number;
  private resizeObserver: ResizeObserver | null = null;
  private fontLoadingDoneHandler: (() => void) | null = null;
  private fontRemeasureTimer: number | null = null;
  // Display identity -- purely cosmetic, no effect on the review/hook
  // plumbing (still keyed by `token` above). `color` is a literal CSS color
  // string (see terminal/colorPalette.ts), not an indirect id.
  private customName: string | null = null;
  private color: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
    this.token = randomHex(16);
    this.terminalNumber = plugin.allocateTerminalNumber();
  }

  getViewType(): string {
    return TERMINUS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.customName ?? `Terminus ${this.terminalNumber}`;
  }

  getIcon(): string {
    return this.plugin.settings.ribbonIcon;
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("terminus-view");
    const xtermContainer = container.createDiv({ cls: "terminus-xterm-container" });

    this.term = new Terminal({
      cursorBlink: this.plugin.settings.cursorBlink,
      cursorStyle: this.plugin.settings.cursorStyle,
      fontSize: this.plugin.settings.fontSize,
      fontFamily: this.plugin.settings.fontFamilyOverride.trim() || resolveMonospaceFontStack(),
      scrollback: this.plugin.settings.scrollbackLines,
      theme: this.plugin.settings.autoThemeTerminal ? resolveXtermTheme() : undefined,
      allowProposedApi: true,
    });
    this.fitAddon = new FitAddon();
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.serializeAddon);
    this.term.open(xtermContainer);
    this.fitAddon.fit();

    // xterm's DOM renderer measures glyph cell size synchronously off
    // whatever font is *currently* available -- it never itself waits on
    // fonts.ready. If the resolved monospace font (a custom font, or a
    // Nerd Font providing the glyphs a shell prompt needs) is still
    // loading at this point, that first measurement locks in fallback-font
    // metrics: box-drawing/prompt glyphs render as tofu ("?"), and once the
    // real font swaps in, its differently-sized glyphs no longer match the
    // cached cell grid, producing misaligned text that persists until
    // something forces a remeasure -- merely resizing the pane doesn't,
    // since fit() only recomputes cols/rows from the (still-stale) cached
    // cell size. Re-applying the font family once fonts genuinely finish
    // loading forces that remeasure against real metrics.
    activeDocument.fonts?.ready.then(() => this.applyFontFamily());

    // fonts.ready only covers glyph subsets the browser has already been
    // asked to load by the time it fires -- many custom/variable fonts are
    // split into several @font-face subsets (Latin, symbols, box-drawing,
    // Nerd Font icon ranges), and the browser only fetches each subset the
    // first time something actually tries to paint a codepoint in it. A
    // shell prompt only exercises the ASCII subset early on, so fonts.ready
    // fires and we remeasure -- then minutes later, the first time Claude
    // Code's CLI prints an icon or box-drawing glyph outside that subset,
    // its font file starts loading *after* our one-shot hook already ran.
    // That late-arriving subset repaints with fallback-font tofu and can
    // reintroduce the stale-cell-grid misalignment, with no further
    // remeasure ever firing. Listening for every subsequent "loadingdone"
    // for the life of this view (debounced, since a subset load fires one
    // event per font file, often several in a burst) keeps the cell grid
    // honest for as long as the terminal stays open.
    this.fontLoadingDoneHandler = () => {
      if (this.fontRemeasureTimer !== null) window.clearTimeout(this.fontRemeasureTimer);
      this.fontRemeasureTimer = window.setTimeout(() => {
        this.fontRemeasureTimer = null;
        this.applyFontFamily();
      }, 100);
    };
    activeDocument.fonts?.addEventListener("loadingdone", this.fontLoadingDoneHandler);

    this.applyRestoredScrollbackIfPending();

    // Obsidian fires this on every theme toggle (dark/light, or switching
    // Obsidian themes entirely) -- registerEvent ties its lifetime to this
    // view, so it's torn down automatically on close, no manual dispose.
    this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));

    this.commandTracker = new CommandTracker(this.term, (cmd) => this.handleCommandFinished(cmd));
    // Debounced, not a raw write -- but without this, workspace.json only
    // picks up a fresh cwd whenever Obsidian happens to re-serialize the
    // layout for its own reasons (pane changes, etc.), which a terminal
    // session cd'ing around never triggers on its own. Without it, a
    // restart resumes wherever the shell happened to be at the *last*
    // incidental layout save, not the cwd the user actually left it in.
    this.cwdTracker = new CwdTracker(this.term, () => this.app.workspace.requestSaveLayout());

    this.plugin.reviewServer.register(this.token, {
      onChangeApplied: (payload) => this.onChangeApplied(payload),
    });

    await this.startPty();

    this.wikiLinkAutocomplete = new WikiLinkAutocomplete({
      app: this.app,
      term: this.term,
      xtermContainer,
      getVaultBasePath: () => this.plugin.getVaultBasePath(),
      getInsertFormat: () => this.plugin.settings.wikiLinkInsertFormat,
      onInsert: (text) => this.pty?.write(text),
      onPassthrough: (text) => this.pty?.write(text),
    });
    this.term.onData((data) => this.wikiLinkAutocomplete?.handleData(data));
    this.term.onResize(({ cols, rows }) => this.pty?.resize(cols, rows));

    // xterm.js's default key handling sends the same \r for Shift+Enter as
    // for plain Enter (evaluateKeyboardEvent only special-cases Alt+Enter,
    // not Shift) -- there's no escape sequence distinguishing them without a
    // protocol the pty helper's shell won't speak (kitty keyboard protocol,
    // CSI u). Readline-style multiline prompts (e.g. Claude Code's own CLI)
    // instead recognize a literal \n written directly as "insert newline"
    // vs \r's "submit", so intercept Shift+Enter here and send \n instead of
    // letting it fall through to xterm's default \r.
    this.term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        this.pty?.write("\n");
        return false;
      }
      return true;
    });

    // Obsidian's own ItemView.onResize() only fires for layout changes it
    // recognizes as a leaf resize (e.g. a full window resize) -- it's not
    // reliable for every actual size change of this container (sidebar
    // toggles, other panels opening/closing, etc.), which lets the PTY's
    // idea of cols/rows silently drift from what's really on screen. A
    // ResizeObserver watches the container element itself, so it catches
    // every real size change regardless of cause.
    this.resizeObserver = new ResizeObserver(() => this.fitAddon?.fit());
    this.resizeObserver.observe(xtermContainer);

    xtermContainer.addEventListener("dragover", (evt) => evt.preventDefault());
    xtermContainer.addEventListener("drop", (evt) => this.handleDrop(evt));

    this.addAction("pencil", "Rename terminal", () => void this.promptRename());
    this.addAction("palette", "Set terminal color", (evt) =>
      openTerminalColorPicker(evt.currentTarget as HTMLElement, this.color, (color) => this.setColor(color))
    );

    // setState() may have already run (restoring a saved name/color) before
    // this point -- apply it now that the container/leaf are actually
    // ready, rather than relying on setState's own timing.
    this.refreshIdentity();
  }

  private async promptRename(): Promise<void> {
    const name = await RenameTerminalModal.prompt(this.app, this.getDisplayText());
    this.customName = name;
    this.refreshIdentity();
  }

  private setColor(color: string | null): void {
    this.color = color;
    this.refreshIdentity();
  }

  private refreshIdentity(): void {
    refreshTabHeader(this.leaf, this.color);
    refreshPaneTitle(this, this.getDisplayText());
  }

  /** Inserts a dropped file's absolute path into the terminal's input line
   *  (typed, not executed -- same "propose, don't run" principle as the
   *  suggested-fix flow). Handles both an OS-level drag (Finder/Explorer,
   *  giving real files resolved via getOsFilePath()) and Obsidian's own
   *  internal vault-file drag (which carries a vault-relative path as
   *  plain text, not a real File). */
  private handleDrop(evt: DragEvent): void {
    evt.preventDefault();
    const dataTransfer = evt.dataTransfer;
    if (!dataTransfer) return;

    const osFile = dataTransfer.files[0];
    const osFilePath = osFile && getOsFilePath(osFile);
    if (osFilePath) {
      this.pty?.write(shellQuoteIfNeeded(osFilePath));
      return;
    }

    const text = dataTransfer.getData("text/plain").trim();
    if (!text) return;

    const abstractFile = this.app.vault.getAbstractFileByPath(text);
    const absolutePath = abstractFile ? pathJoin(this.plugin.getVaultBasePath(), text) : text;
    this.pty?.write(shellQuoteIfNeeded(absolutePath));
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.fontLoadingDoneHandler) {
      activeDocument.fonts?.removeEventListener("loadingdone", this.fontLoadingDoneHandler);
      this.fontLoadingDoneHandler = null;
    }
    if (this.fontRemeasureTimer !== null) {
      window.clearTimeout(this.fontRemeasureTimer);
      this.fontRemeasureTimer = null;
    }
    this.plugin.reviewServer.unregister(this.token);
    this.pty?.kill();
    this.commandTracker?.dispose();

    // Captured before disposal so "Rescue closed terminal" can bring the
    // transcript (and cwd) back later -- same content getState() would have
    // saved for a restart, just routed into the in-session buffer instead.
    this.plugin.closedTerminals.push({
      displayText: this.getDisplayText(),
      scrollback: this.serializeScrollback(),
      cwd: this.cwdTracker?.getCwd() ?? this.restoredCwd,
      customName: this.customName,
      color: this.color,
      closedAt: Date.now(),
    });

    this.cwdTracker?.dispose();
    this.wikiLinkAutocomplete?.dispose();
    for (const decoration of this.failureBadges.values()) decoration.dispose();
    this.failureBadges.clear();
    this.term?.dispose();
  }

  getState(): Record<string, unknown> {
    return {
      ...super.getState(),
      scrollback: this.serializeScrollback(),
      cwd: this.cwdTracker?.getCwd() ?? this.restoredCwd ?? undefined,
      customName: this.customName ?? undefined,
      color: this.color ?? undefined,
    };
  }

  /**
   * A running program (Claude Code's own TUI included) can leave DEC
   * private modes switched on -- focus reporting, bracketed paste, mouse
   * tracking, the alternate screen buffer -- and SerializeAddon faithfully
   * re-emits whichever of those were active as part of its default output,
   * so replaying it would re-arm them in the restored terminal too. That's
   * fine when the *same* program keeps running, but a restore always spawns
   * a brand new plain shell with no idea any of that state exists. Left
   * armed, e.g. focus reporting, every later Obsidian pane/tab focus change
   * makes xterm.js write a raw `ESC[I`/`ESC[O` to that shell, which has no
   * handler for it and echoes the bytes back as literal garbage on the
   * input line -- the exact "^[[O%" corruption this fixes. Scrollback text
   * itself is still worth keeping (so the user sees prior output), just not
   * the mode/alt-buffer state that assumes the same program is still there.
   */
  private serializeScrollback(): string {
    return (
      this.serializeAddon?.serialize({
        scrollback: SCROLLBACK_PERSIST_LINES,
        excludeModes: true,
        excludeAltBuffer: true,
      }) ?? ""
    );
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const typedState = state as { scrollback?: unknown; cwd?: unknown; customName?: unknown; color?: unknown } | null;
    const scrollback = typedState?.scrollback;
    if (typeof scrollback === "string" && scrollback.length > 0) {
      if (this.term) {
        this.writeRestoredScrollback(scrollback);
      } else {
        // Terminal isn't constructed yet -- onOpen hasn't run, or hasn't
        // reached this point yet. Stash it; onOpen applies it once ready.
        this.restoredScrollback = scrollback;
      }
    }
    if (typeof typedState?.cwd === "string" && typedState.cwd.length > 0) {
      this.restoredCwd = typedState.cwd;
    }
    // customName/color are plain display fields (no PTY-spawn-time
    // dependency like cwd, no terminal-buffer dependency like scrollback),
    // so they're just assigned directly -- refreshIdentity() re-applies
    // them once onOpen's DOM/leaf actually exist, whichever order this
    // races with onOpen in.
    if (typeof typedState?.customName === "string" && typedState.customName.length > 0) {
      this.customName = typedState.customName;
    }
    if (typeof typedState?.color === "string" && typedState.color.length > 0) {
      this.color = typedState.color;
    }
    this.refreshIdentity();
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

  applyFontFamily(): void {
    if (!this.term) return;
    const family = this.plugin.settings.fontFamilyOverride.trim() || resolveMonospaceFontStack();
    // xterm's options setter only fires its change event (which drives the
    // glyph-cell remeasure) when the new value differs from the current one
    // -- and `family` here is usually identical to what's already set, since
    // nothing about the resolved font string changes between pane-open and
    // fonts.ready. Toggling through an empty value first forces a real
    // inequality so the remeasure actually happens instead of silently
    // no-opping.
    this.term.options.fontFamily = "";
    this.term.options.fontFamily = family;
    this.fitAddon?.fit();
    this.pty?.resize(this.term.cols, this.term.rows);
  }

  applyCursorStyle(): void {
    if (!this.term) return;
    this.term.options.cursorStyle = this.plugin.settings.cursorStyle;
  }

  applyCursorBlink(): void {
    if (!this.term) return;
    this.term.options.cursorBlink = this.plugin.settings.cursorBlink;
  }

  applyTheme(): void {
    if (!this.term) return;
    this.term.options.theme = this.plugin.settings.autoThemeTerminal ? resolveXtermTheme() : undefined;
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

    // A restored cwd might no longer exist (deleted/moved directory since
    // the last session) -- fall back rather than handing PtyProcess a path
    // that would make the shell's own cwd-change (or the spawn itself) fail.
    const restoredCwdStillExists = this.restoredCwd && fileExistsSync(this.restoredCwd);
    this.pty = new PtyProcess({
      pythonBin,
      helperPath,
      shell,
      cwd: restoredCwdStillExists ? this.restoredCwd! : this.plugin.getVaultBasePath(),
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

    this.pty.on("data", (chunk: Buffer) => this.term?.write(bufferToString(chunk)));
    this.pty.on("stderr", (text: string) => new Notice(`Terminus: ${text.trim()}`));
    this.pty.on("error", (err) => new Notice(`Terminus: PTY error: ${errorMessage(err)}`));
    this.pty.on("exit", ({ code }: { code: number | null }) => {
      this.term?.write(`\r\n[process exited${code !== null ? ` with code ${code}` : ""}]\r\n`);
    });
    this.pty.on("ready", () => {
      const command = this.plugin.settings.startupCommand.trim();
      if (command) this.pty?.write(`${command}\r`);
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
      panelColor: this.color,
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
