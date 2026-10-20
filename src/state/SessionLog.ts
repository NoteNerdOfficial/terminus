import { Notice, TFile, normalizePath } from "obsidian";
import { computeDiffStats } from "../diff/renderDiff";
import { describeStatus } from "../git/gitStatus";
import type { DiffResult } from "../server/diff";
import type { ShellChange } from "./AgentSessionStore";
import {
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
 * killed Obsidian keeps everything up to its last finished turn. The only
 * rewrite is one frontmatter update when the session ends, which marks it
 * `ended` and records its totals for a Bases view to pick up.
 */

/** One file Claude changed in the turn being accumulated. */
interface LoggedEdit {
  filePath: string;
  /** Tool calls that touched this file in this turn. */
  editCount: number;
  /** Summed over those calls; see flush() for when the pending row's own
   *  cumulative stats are preferred instead. */
  added: number;
  removed: number;
  agentId: string | null;
  agentType: string | null;
}


interface LogState {
  /** The Claude session this note belongs to. A different id (a /clear, or
   *  a fresh `claude`) starts a new note. */
  sessionId: string | null;
  /** The note, once created; null until the first turn is appended, so a
   *  session that never finishes a turn leaves no empty note behind. */
  path: string | null;
  /** Edits not yet written out, by prompt_id then by file. Keyed by turn so
   *  an edit that lands after its turn's section was written can't be filed
   *  under the next one. */
  pending: Map<string, Map<string, LoggedEdit>>;
  turnsWritten: number;
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

export class SessionLog {
  private states = new Map<string, LogState>();
  /** Absolute paths of the notes this log has written. The shell-change
   *  pass skips them: a log note is a file that appeared in the vault with
   *  no edit hook behind it, which is exactly its own definition of one of
   *  Claude's shell edits, so without this Terminus would report its own
   *  bookkeeping back to the user as something Claude did. */
  private ownNotes = new Set<string>();

  constructor(private plugin: TerminusPlugin) {}

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
    const bucket = state.pending.get(key) ?? new Map<string, LoggedEdit>();
    const stats = computeDiffStats(diff);
    const existing = bucket.get(diff.filePath);
    bucket.set(diff.filePath, {
      filePath: diff.filePath,
      editCount: (existing?.editCount ?? 0) + 1,
      added: (existing?.added ?? 0) + stats.added,
      removed: (existing?.removed ?? 0) + stats.removed,
      // The first agent to touch the file owns the row, as it does in the
      // inbox (see PendingChangesStore.recordChange).
      agentId: existing?.agentId ?? agent?.id ?? null,
      agentType: existing?.agentType ?? agent?.type ?? null,
    });
    state.pending.set(key, bucket);
  }

  /** Stop or StopFailure: writes the turn's section, creating the note on
   *  the first one. `shellChanges` are the ones this turn introduced. */
  appendTurn(token: string, promptId: string | undefined, shellChanges: ShellChange[]): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const state = this.ensure(token);
    return this.serialise(state, async () => {
      const session = this.plugin.agentSessionStore.get(token);
      if (!session) return;
      const key = promptId ?? NO_PROMPT;
      const bucket = state.pending.get(key) ?? new Map<string, LoggedEdit>();
      state.pending.delete(key);

      const record = promptId ? session.turns.find((turn) => turn.promptId === promptId) : null;
      // The turn's own place in the session, so the note's numbering matches
      // the inbox's. A turn the store no longer has falls back to counting
      // the sections written so far.
      const index = record ? session.turns.indexOf(record) + 1 : state.turnsWritten + 1;
      const view: TurnLogView = {
        index,
        prompt: record?.prompt ?? null,
        startedAt: record?.startedAt ?? Date.now(),
        endedAt: record?.endedAt ?? null,
        failed: record?.failed ?? session.lastTurnFailed,
        lastMessage: session.lastMessage,
        files: [...bucket.values()].map((edit) => this.fileView(token, edit)),
        // Decoded and made vault-relative here: the formatter knows nothing
        // of git's letters or of where the vault is.
        shellChanges: shellChanges.map((change) => ({
          path: vaultRelative(this.plugin, change.filePath),
          status: describeStatus(change.status),
        })),
      };

      const file = await this.noteFor(token, state, session.cwd, session.branch);
      if (!file) return;
      await this.plugin.app.vault.append(file, formatTurnSection(view));
      state.turnsWritten++;
      for (const edit of bucket.values()) state.filesWritten.add(edit.filePath);
    });
  }

  /** The session is over, however it ended: one closing line and the
   *  frontmatter totals. Does nothing for a session that never wrote a turn. */
  endSession(token: string): Promise<void> {
    const state = this.states.get(token);
    if (!state || state.closed) return Promise.resolve();
    state.closed = true;
    // No turn ever finished, so there is no note and nothing to close off.
    if (state.path === null) {
      this.states.delete(token);
      return Promise.resolve();
    }
    return this.serialise(state, async () => {
      const file = this.fileAt(state.path);
      if (!file) return;
      const session = this.plugin.agentSessionStore.get(token);
      const activeMs = session ? session.turns.reduce((total, turn) => total + ((turn.endedAt ?? turn.startedAt) - turn.startedAt), 0) : 0;
      const totals = { turns: state.turnsWritten, files: state.filesWritten.size, activeMs, endedAt: Date.now() };
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
      // Nothing more will be written for this session. A new `claude` in the
      // same terminal gets a fresh state from sessionStarted.
    }).finally(() => this.states.delete(token));
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
    const terminalName = this.plugin.findTerminalView(token)?.getDisplayText() ?? "Terminus";
    const header: SessionHeaderView = { sessionId: state.sessionId, terminalName, startedAt: state.startedAt, cwd, branch };
    const path = await this.claimPath(folder, state, terminalName);
    if (path === null) return null;
    // A note already there for this same session is one from before a
    // restart: keep appending to it rather than starting a second.
    const found = this.fileAt(path);
    if (found) {
      state.path = path;
      this.ownNotes.add(this.absolute(path));
      return found;
    }
    const file = await this.plugin.app.vault.create(path, formatSessionHeader(header));
    state.path = path;
    this.ownNotes.add(this.absolute(path));
    return file;
  }

  /**
   * Where this session's note goes: "<folder>/<date> <time> <terminal>.md".
   * An existing note for the same session id is reused (a restart mid-
   * session); one for a different session gets a counter, so two sessions
   * that start in the same minute in the same terminal can't collide.
   */
  private async claimPath(folder: string, state: LogState, terminalName: string): Promise<string | null> {
    const base = `${stamp(state.startedAt)} ${safeFileName(terminalName)}`.trim();
    for (let n = 1; n <= 20; n++) {
      const path = normalizePath(`${folder}/${base}${n === 1 ? "" : ` ${n}`}.md`);
      const file = this.fileAt(path);
      if (!file) return path;
      const recorded = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.["terminus-session-id"];
      if (state.sessionId !== null && recorded === state.sessionId) return path;
    }
    return null;
  }

  /** Creates the configured folder if it isn't there, one level at a time;
   *  null when it can't be made or the setting is empty. */
  private async ensureFolder(): Promise<string | null> {
    const configured = normalizePath(this.plugin.settings.multiAgent.sessionLogFolder.trim() || "Terminus/Sessions");
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
