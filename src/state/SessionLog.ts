import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { computeDiffStats } from "../diff/renderDiff";
import { describeStatus } from "../git/gitStatus";
import type { DiffResult } from "../server/diff";
import type { ShellChange } from "./AgentSessionStore";
import { titleFromPrompt } from "../groups/groupNaming";
import {
  formatSessionBase,
  formatSessionClosing,
  formatSessionHeader,
  formatTurnSection,
  localIso,
  safeFileName,
  stamp,
  type LoggedFileView,
  type SessionHeaderView,
  type TurnLogView,
} from "./sessionLogFormat";
import type TerminusPlugin from "../main";

/**
 * Writes one note per Claude session into the vault, a section appended as
 * each turn ends: the prompt, the files that turn changed and by how much,
 * how long it took, and anything it changed outside Claude's edit tools.
 *
 * Off unless the user turns it on (Settings -> Terminus -> Multi-agent ->
 * "Log sessions to notes"), because it is the one part of Terminus that
 * puts prompts on disk. ActionLog deliberately keeps none -- see its own
 * comment -- so this is the opt-in that reverses that stance, and it says
 * so in the settings description rather than burying it here.
 *
 * Entirely deterministic: every line comes from a hook payload or a store
 * record, formatted the same way every run. Nothing is summarised, inferred
 * or sent to a model, so there is no token cost, no latency and nothing
 * that can describe a session wrongly. The note's exact wording lives in
 * sessionLogFormat.ts, as pure functions, for exactly that reason.
 *
 * Appends rather than rewrites, so a session cut short by a crash or a
 * killed Obsidian keeps everything already written. The body is only ever
 * added to; the frontmatter is rewritten when the session ends (marking it
 * `ended` with its totals, for a Bases view to pick up) and, rarely, when a
 * note is adopted back (see reopen).
 *
 * One note per Claude session, not per terminal. A session keeps its note
 * across an Obsidian restart, found by the id in its frontmatter rather
 * than by its name -- the name carries the session's start time, which a
 * restarted plugin no longer knows. A /clear is a different session id, so
 * it closes the old note off and starts a new one: that conversation is
 * gone, and nothing else would ever report it, since /clear does not take
 * the session through SessionEnd.
 */

/** One file Claude changed in the turn being accumulated. */
interface LoggedEdit {
  filePath: string;
  /** Tool calls that touched this file in this turn. */
  editCount: number;
  /** Summed over those calls; see fileView() for when the pending row's own
   *  cumulative stats are preferred instead. */
  added: number;
  removed: number;
  agentId: string | null;
  agentType: string | null;
}


/**
 * A turn being accumulated: its edits so far, plus enough about the turn
 * itself to write a section without the agent store. That matters because a
 * /clear resets the store before this ever hears about it (see
 * TerminalView's SessionStart case), and because a session resumed after a
 * restart comes back with an empty turn list.
 */
interface PendingTurn {
  prompt: string | null;
  startedAt: number;
  files: Map<string, LoggedEdit>;
}

interface LogState {
  /** The Claude session this note belongs to. A different id (a /clear, or
   *  a fresh `claude`) starts a new note. */
  sessionId: string | null;
  /** The note, once created; null until the first turn is appended, so a
   *  session that never finishes a turn leaves no empty note behind. */
  path: string | null;
  /** Turns not yet written out, by prompt_id. Keyed by turn so an edit that
   *  lands after its turn's section was written can't be filed under the
   *  next one, and so an unfinished turn can still be flushed on close. */
  pending: Map<string, PendingTurn>;
  turnsWritten: number;
  /** The written turns' durations added up, for the closing line. Kept here
   *  rather than recomputed from the agent store at the end, which by then
   *  may have been reset (/clear) or restarted empty. */
  activeMs: number;
  /** Distinct files written across the session, for the closing totals. */
  filesWritten: Set<string>;
  /** Serialises this session's writes: two appends must never interleave. */
  queue: Promise<void>;
  startedAt: number;
  /** Set once the closing summary is written, so the three different
   *  "session is over" call sites can't write it three times. */
  closed: boolean;
  /** One failure notice per session rather than one per turn. */
  warned: boolean;
}

/** A turn with no prompt_id at all (hooks installed mid-turn) still gets a
 *  bucket, under this key. */
const NO_PROMPT = "";

/** Used when the folder setting is blank. */
const DEFAULT_FOLDER = "Terminus/Sessions";

/** The Bases view dropped in beside the notes. Named for what it holds
 *  rather than after the folder, which the user chooses and may rename. */
const BASE_NAME = "Terminus sessions.base";

export class SessionLog {
  private states = new Map<string, LogState>();
  /** Absolute paths of the notes this log has written. The shell-change
   *  pass skips them: a log note is a file that appeared in the vault with
   *  no edit hook behind it, which is exactly its own definition of one of
   *  Claude's shell edits, so without this Terminus would report its own
   *  bookkeeping back to the user as something Claude did. */
  private ownNotes = new Set<string>();

  constructor(private plugin: TerminusPlugin) {}

  /**
   * Marks notes left `active` by a previous run as `abandoned`.
   *
   * A session whose Obsidian was killed never reaches endSession, so its
   * note would otherwise claim to be active forever, and a Bases view over
   * these would count it among the live ones. Run once at startup, where
   * "active" is unambiguous: nothing has started yet, so a note still
   * saying so belongs to a run that is over.
   *
   * Only the frontmatter is touched, deliberately. A session that IS about
   * to be resumed gets marked here and then adopted moments later (see
   * noteFor), which flips it back; doing that in the body would leave a
   * stale "abandoned" line stranded mid-note, and would make this the one
   * thing that rewrites a note's body. `terminus-ended` stays unset, which
   * is what tells an abandoned note from one that ended properly.
   */
  async sweepAbandoned(): Promise<void> {
    if (!this.enabled) return;
    const folder = normalizePath(this.plugin.settings.multiAgent.sessionLogFolder.trim() || DEFAULT_FOLDER);
    const dir = this.plugin.app.vault.getAbstractFileByPath(folder);
    if (!(dir instanceof TFolder)) return;
    const live = new Set(this.plugin.agentSessionStore.list().filter((session) => session.running).map((session) => session.sessionId));
    for (const child of dir.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const frontmatter = this.plugin.app.metadataCache.getFileCache(child)?.frontmatter;
      if (frontmatter?.["terminus-session-status"] !== "active") continue;
      const sessionId: unknown = frontmatter["terminus-session-id"];
      if (typeof sessionId === "string" && live.has(sessionId)) continue;
      const turns = await this.sectionsIn(child);
      try {
        await this.plugin.app.fileManager.processFrontMatter(child, (fm: Record<string, unknown>) => {
          fm["terminus-session-status"] = "abandoned";
          fm["terminus-turns"] = turns;
        });
      } catch {
        // A note the vault refused, or one being edited right now; it stays
        // `active` and is swept on the next startup instead.
      }
    }
  }

  /** Whether this absolute path is a note this log wrote; see ownNotes. */
  ownsPath(absolutePath: string): boolean {
    return this.ownNotes.has(absolutePath);
  }

  private get enabled(): boolean {
    return this.plugin.experience === "multi-agent" && this.plugin.settings.multiAgent.logSessions;
  }

  /** SessionStart. A different session id under the same terminal gets its
   *  own note, matching AgentSessionStore's own clean slate on /clear. */
  sessionStarted(token: string, sessionId: string | null): void {
    if (!this.enabled) return;
    const existing = this.states.get(token);
    if (existing && existing.sessionId === sessionId) return;
    // A different id in the same terminal is a /clear, or a fresh `claude`
    // after the last one exited. That conversation is over and keeps its own
    // note, so it is closed off properly here rather than left open forever
    // with no totals -- nothing else reports it, since /clear never takes
    // the session through SessionEnd.
    if (existing) void this.closeState(token, existing);
    this.states.set(token, create(sessionId, Date.now()));
  }

  /**
   * One edit, as its PreToolUse hook reported it. Accumulated rather than
   * read back from PendingChangesStore at the turn's end, so a change the
   * user accepts or rejects mid-turn is still logged: this records what
   * Claude did, which is not the same question as what is left to review.
   */
  noteEdit(token: string, diff: DiffResult, promptId: string | undefined, agent: { id: string; type: string } | null): void {
    if (!this.enabled) return;
    const state = this.ensure(token);
    const key = promptId ?? NO_PROMPT;
    let bucket = state.pending.get(key);
    if (!bucket) {
      // The turn's own details are taken now, while the agent store still
      // has them: by the time this turn is written out the store may have
      // been reset by a /clear, and on a resumed session it never had them.
      const record = promptId ? this.plugin.agentSessionStore.get(token)?.turns.find((turn) => turn.promptId === promptId) : undefined;
      bucket = { prompt: record?.prompt ?? null, startedAt: record?.startedAt ?? Date.now(), files: new Map() };
      state.pending.set(key, bucket);
    }
    const stats = computeDiffStats(diff);
    const existing = bucket.files.get(diff.filePath);
    bucket.files.set(diff.filePath, {
      filePath: diff.filePath,
      editCount: (existing?.editCount ?? 0) + 1,
      added: (existing?.added ?? 0) + stats.added,
      removed: (existing?.removed ?? 0) + stats.removed,
      // The first agent to touch the file owns the row, as it does in the
      // inbox (see PendingChangesStore.recordChange).
      agentId: existing?.agentId ?? agent?.id ?? null,
      agentType: existing?.agentType ?? agent?.type ?? null,
    });
  }

  /** Stop or StopFailure: writes the turn's section, creating the note on
   *  the first one. `shellChanges` are the ones this turn introduced. */
  appendTurn(token: string, promptId: string | undefined, shellChanges: ShellChange[]): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const state = this.ensure(token);
    return this.serialise(state, async () => {
      const session = this.plugin.agentSessionStore.get(token);
      if (!session) return;
      // The note is resolved first: adopting one after a restart is what
      // tells this state how many sections the note already holds, and the
      // turn is numbered from that. Resolving it after building the view
      // numbered the first turn back from 1 on every restart.
      const file = await this.noteFor(token, state, session.cwd, session.branch);
      // Without a note there is nowhere to write; the turn stays pending, so
      // closing the session still flushes it rather than losing it.
      if (!file) return;

      const key = promptId ?? NO_PROMPT;
      const bucket = state.pending.get(key);
      state.pending.delete(key);

      const record = promptId ? session.turns.find((turn) => turn.promptId === promptId) : null;
      const startedAt = record?.startedAt ?? bucket?.startedAt ?? Date.now();
      const endedAt = record?.endedAt ?? null;
      const edits = [...(bucket?.files.values() ?? [])];
      const view: TurnLogView = {
        // Numbered by what this note already holds, not by the turn's place
        // in the agent store's list. That list is capped (MAX_TURNS), so a
        // long session renumbered its turns once the oldest fell off it, and
        // it comes back empty on a resumed session, so one picked up after a
        // restart began again at 1. The count of sections written is what
        // the heading is actually claiming.
        index: state.turnsWritten + 1,
        prompt: record?.prompt ?? bucket?.prompt ?? null,
        startedAt,
        endedAt,
        failed: record?.failed ?? session.lastTurnFailed,
        unfinished: false,
        lastMessage: session.lastMessage,
        files: edits.map((edit) => this.fileView(token, edit)),
        // Decoded and made vault-relative here: the formatter knows nothing
        // of git's letters or of where the vault is.
        shellChanges: shellChanges.map((change) => ({
          path: vaultRelative(this.plugin, change.filePath),
          status: describeStatus(change.status),
        })),
      };

      await this.plugin.app.vault.append(file, formatTurnSection(view));
      state.turnsWritten++;
      if (endedAt !== null) state.activeMs += Math.max(0, endedAt - startedAt);
      for (const edit of edits) state.filesWritten.add(edit.filePath);
    });
  }

  /** The session is over, however it ended: one closing line and the
   *  frontmatter totals. Does nothing for a session that never wrote a turn. */
  endSession(token: string): Promise<void> {
    const state = this.states.get(token);
    if (!state) return Promise.resolve();
    return this.closeState(token, state).finally(() => {
      // Only if nothing has taken its place: a /clear closes the old state
      // and installs a new one under the same token in the same tick.
      if (this.states.get(token) === state) this.states.delete(token);
    });
  }

  /**
   * Writes a session's last lines: any turn still being accumulated, then
   * the closing summary and the frontmatter totals. Takes everything it
   * needs from the state rather than the agent store, which on a /clear has
   * already been reset for the session that replaced this one.
   */
  private closeState(token: string, state: LogState): Promise<void> {
    if (state.closed) return Promise.resolve();
    state.closed = true;
    // No turn ever finished, so there is no note and nothing to close off.
    if (state.path === null) return Promise.resolve();
    return this.serialise(state, async () => {
      const file = this.fileAt(state.path);
      if (!file) return;

      // A turn whose Stop never came -- Claude killed mid-turn, Obsidian
      // quit, or a /clear typed while it worked. Its edits reached disk, so
      // dropping them would make the note claim less happened than did.
      for (const bucket of state.pending.values()) {
        const edits = [...bucket.files.values()];
        if (edits.length === 0) continue;
        await this.plugin.app.vault.append(
          file,
          formatTurnSection({
            index: state.turnsWritten + 1,
            prompt: bucket.prompt,
            startedAt: bucket.startedAt,
            endedAt: null,
            failed: false,
            unfinished: true,
            lastMessage: null,
            files: edits.map((edit) => this.fileView(token, edit)),
            shellChanges: [],
          })
        );
        state.turnsWritten++;
        for (const edit of edits) state.filesWritten.add(edit.filePath);
      }
      state.pending.clear();

      const totals = { turns: state.turnsWritten, files: state.filesWritten.size, activeMs: state.activeMs, endedAt: Date.now() };
      await this.plugin.app.vault.append(file, formatSessionClosing(totals));
      try {
        await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter["terminus-session-status"] = "ended";
          frontmatter["terminus-turns"] = totals.turns;
          frontmatter["terminus-files"] = totals.files;
          frontmatter["terminus-ended"] = localIso(totals.endedAt);
        });
      } catch {
        // The closing line is already in the note; a frontmatter write that
        // loses a race with the user editing the file isn't worth a notice.
      }
    });
  }

  /** The session's state, created on demand -- which happens when logging
   *  was switched on partway through a session, or in Classic-to-Multi-agent
   *  switches where no SessionStart was seen. */
  private ensure(token: string): LogState {
    const existing = this.states.get(token);
    if (existing) return existing;
    const session = this.plugin.agentSessionStore.get(token);
    // Date the note from the session's first turn, not from the moment the
    // setting was flipped, so its name and header match the work in it.
    const state = create(session?.sessionId ?? null, session?.turns[0]?.startedAt ?? Date.now());
    this.states.set(token, state);
    return state;
  }

  /** Runs `work` after whatever this session is already writing, so appends
   *  land in turn order and never interleave. A failure is reported once per
   *  session and never breaks the chain. */
  private serialise(state: LogState, work: () => Promise<void>): Promise<void> {
    const next = state.queue.then(work, work).catch((err: unknown) => {
      if (state.warned) return;
      state.warned = true;
      new Notice(`Terminus: couldn't write the session log: ${err instanceof Error ? err.message : String(err)}`);
    });
    state.queue = next;
    return next;
  }

  /** A vault-relative note path as the absolute one the git pass compares. */
  private absolute(vaultPath: string): string {
    return `${this.plugin.getVaultBasePath().replace(/\/+$/, "")}/${vaultPath}`;
  }

  private fileAt(path: string | null): TFile | null {
    if (!path) return null;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  /** The session's note, created with its header on the first call. */
  private async noteFor(token: string, state: LogState, cwd: string | null, branch: string | null): Promise<TFile | null> {
    const existing = this.fileAt(state.path);
    if (existing) return existing;
    const folder = await this.ensureFolder();
    if (folder === null) return null;
    // A note already in the folder for this same session: Obsidian restarted
    // or the plugin reloaded while the session carried on, and Terminus
    // picked it back up with its id intact. It is found by frontmatter, not
    // by name, because the name carries the session's original start time
    // and this process no longer knows it -- matching on the name alone is
    // what used to split one session across a second note on every restart.
    const adopted = state.sessionId ? this.findNoteForSession(folder, state.sessionId) : null;
    if (adopted) {
      state.path = adopted.path;
      this.ownNotes.add(this.absolute(adopted.path));
      // Continue the note's own numbering rather than starting again at 1.
      state.turnsWritten = await this.sectionsIn(adopted);
      await this.reopen(adopted);
      return adopted;
    }

    await this.ensureBase(folder);
    const terminalName = this.plugin.findTerminalView(token)?.getDisplayText() ?? "Terminus";
    const header: SessionHeaderView = {
      sessionId: state.sessionId,
      terminalName,
      startedAt: state.startedAt,
      cwd,
      branch,
      goal: this.goalFor(token, state),
    };
    const path = this.claimPath(folder, state, terminalName);
    if (path === null) return null;
    const file = await this.plugin.app.vault.create(path, formatSessionHeader(header));
    state.path = path;
    this.ownNotes.add(this.absolute(path));
    return file;
  }

  /**
   * A free name for a new session's note: "<folder>/<date> <time>
   * <terminal>.md", with a counter if two sessions start in the same minute
   * in the same terminal. Reuse of an existing session's note is settled
   * before this, by frontmatter (see noteFor).
   */
  private claimPath(folder: string, state: LogState, terminalName: string): string | null {
    const base = `${stamp(state.startedAt)} ${safeFileName(terminalName)}`.trim();
    for (let n = 1; n <= 20; n++) {
      const path = normalizePath(`${folder}/${base}${n === 1 ? "" : ` ${n}`}.md`);
      if (!this.fileAt(path)) return path;
    }
    return null;
  }

  /** The note in `folder` whose frontmatter records this session id. Null
   *  when there is none, or while the metadata cache is still indexing the
   *  vault, in which case the session simply starts a new note. */
  private findNoteForSession(folder: string, sessionId: string): TFile | null {
    const dir = this.plugin.app.vault.getAbstractFileByPath(folder);
    if (!(dir instanceof TFolder)) return null;
    for (const child of dir.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      if (this.plugin.app.metadataCache.getFileCache(child)?.frontmatter?.["terminus-session-id"] === sessionId) return child;
    }
    return null;
  }

  /** How many turn sections a note already holds. Read off its headings,
   *  which is safe precisely because a prompt is written as a blockquote: a
   *  line can only begin "## Turn " if this wrote it. */
  private async sectionsIn(file: TFile): Promise<number> {
    try {
      const text = await this.plugin.app.vault.cachedRead(file);
      let highest = 0;
      for (const match of text.matchAll(/^## Turn (\d+)/gm)) highest = Math.max(highest, Number(match[1]));
      return highest;
    } catch {
      return 0;
    }
  }

  /** Marks an adopted note active again: one that ended cleanly and was then
   *  resumed (`claude --resume` keeps its id), or one the startup sweep had
   *  just written off as abandoned when the session was in fact coming
   *  back. Either way it would otherwise keep appending turns under a header
   *  saying it had finished. */
  private async reopen(file: TFile): Promise<void> {
    const status = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.["terminus-session-status"];
    if (status !== "ended" && status !== "abandoned") return;
    try {
      await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        frontmatter["terminus-session-status"] = "active";
      });
    } catch {
      // Cosmetic; the closing write at the end sets it correctly anyway.
    }
  }

  /**
   * What the session set out to do: its first prompt, reduced to a title the
   * same way a terminal group's name is, so the two agree on what a session
   * is called. Read once, when the note's header is written.
   *
   * The agent store is asked first and the turn being accumulated second:
   * the store has the prompt for an ordinary session, but it has been reset
   * by a /clear, and comes back empty on one resumed after a restart, in
   * which cases the bucket is the only place the text survives. Null when
   * neither has one -- a session whose first prompt was a bare slash
   * command, which titleFromPrompt declines to name.
   */
  private goalFor(token: string, state: LogState): string | null {
    const first =
      this.plugin.agentSessionStore.get(token)?.turns.find((turn) => turn.prompt)?.prompt ??
      [...state.pending.values()].find((bucket) => bucket.prompt)?.prompt ??
      null;
    return first ? titleFromPrompt(first) : null;
  }

  /**
   * Writes the Bases view into the log folder, once ever.
   *
   * Once is tracked in settings rather than by the file's absence, because
   * those two differ in the case that matters: a user who deleted it has
   * said they don't want it, and recreating it at the next session would be
   * the plugin overruling them. A vault that refuses the write leaves the
   * flag unsaved, so it is tried again next launch rather than every turn.
   */
  private async ensureBase(folder: string): Promise<void> {
    const settings = this.plugin.settings.multiAgent;
    if (settings.sessionBaseCreated || !this.plugin.supportsBases) return;
    // Set before the await: two terminals starting together must not both
    // get as far as creating it.
    settings.sessionBaseCreated = true;
    try {
      const path = normalizePath(`${folder}/${BASE_NAME}`);
      if (!this.plugin.app.vault.getAbstractFileByPath(path)) {
        await this.plugin.app.vault.create(path, formatSessionBase());
      }
      await this.plugin.saveSettings();
    } catch {
      settings.sessionBaseCreated = false;
    }
  }

  /** Creates the configured folder if it isn't there, one level at a time;
   *  null when it can't be made or the setting is empty. */
  private async ensureFolder(): Promise<string | null> {
    const configured = normalizePath(this.plugin.settings.multiAgent.sessionLogFolder.trim() || DEFAULT_FOLDER);
    const segments = configured.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return null;
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      if (this.plugin.app.vault.getAbstractFileByPath(path)) continue;
      try {
        await this.plugin.app.vault.createFolder(path);
      } catch {
        // Already there (another terminal got here first), or the vault
        // refused it; the next lookup settles which.
        if (!this.plugin.app.vault.getAbstractFileByPath(path)) return null;
      }
    }
    return path;
  }

  private fileView(token: string, edit: LoggedEdit): LoggedFileView {
    const path = vaultRelative(this.plugin, edit.filePath);
    const inVault = path !== edit.filePath;
    // The pending row, when there still is one, holds the true pre-turn to
    // now diff for the file; the accumulated per-call sums double-count a
    // line edited twice. Preferred when available, which is the usual case.
    const pending = this.plugin.pendingChangesStore.get(edit.filePath);
    const stats = pending ? computeDiffStats(pending.diff) : { added: edit.added, removed: edit.removed };
    return {
      path: inVault ? path : edit.filePath,
      linkable: inVault && !/[[\]|#^]/.test(path),
      editCount: edit.editCount,
      added: stats.added,
      removed: stats.removed,
      agentLabel: edit.agentId ? this.agentLabel(token, edit.agentId, edit.agentType) : null,
    };
  }

  private agentLabel(token: string, agentId: string, agentType: string | null): string {
    const run = this.plugin.agentSessionStore.get(token)?.subagents.find((r) => r.agentId === agentId);
    return run?.description ?? run?.agentType ?? agentType ?? "subagent";
  }
}

function create(sessionId: string | null, startedAt: number): LogState {
  return {
    sessionId,
    path: null,
    pending: new Map(),
    turnsWritten: 0,
    activeMs: 0,
    filesWritten: new Set(),
    queue: Promise.resolve(),
    startedAt,
    closed: false,
    warned: false,
  };
}

function vaultRelative(plugin: TerminusPlugin, absolutePath: string): string {
  const base = plugin.getVaultBasePath();
  if (!absolutePath.startsWith(base)) return absolutePath;
  return absolutePath.slice(base.length).replace(/^\/+/, "");
}
