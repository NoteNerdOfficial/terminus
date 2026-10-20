import { TypedEmitter } from "../node/emitter";
import type { UsageTotals } from "../claude/transcriptUsage";

/**
 * - `working`: Claude is mid-turn.
 * - `needs-attention`: Claude asked for permission, or is waiting on input.
 * - `finished-unread`: the turn ended and nobody has looked at the terminal since.
 * - `idle`: the turn ended and the terminal has been looked at since, or no turn yet.
 */
export type AgentStatus = "working" | "needs-attention" | "finished-unread" | "idle";

/**
 * Why a session needs attention, when the Notification payload says:
 * - `permission`: a permission prompt is open.
 * - `input`: Claude is waiting on input mid-turn.
 * - `unread-turn`: the turn ended, nobody has looked, and Claude has since
 *   reported it's idle. Looking at the terminal clears it.
 */
export type NeedsKind = "permission" | "input" | "unread-turn";

/**
 * One user turn: the prompt that opened it, and when it ran. Keyed by
 * Claude Code's `prompt_id`, which (captured from 2.1.304) is stable for a
 * whole turn across every API request in it, and is carried by the lead's
 * edits, its subagents' edits and the turn's Stop alike -- so it's what
 * ties a file change back to the request that caused it.
 */
export interface TurnRecord {
  promptId: string;
  /** The prompt, truncated. Null for a turn first seen through one of its
   *  edits rather than its UserPromptSubmit: Classic installs no such hook,
   *  and in Multi-agent the hooks can be installed mid-turn. */
  prompt: string | null;
  startedAt: number;
  /** Null while the turn runs. */
  endedAt: number | null;
  /** Ended in a StopFailure rather than a Stop. */
  failed: boolean;
}

/** A file in the session's folder that changed with no Edit/Write/
 *  NotebookEdit hook to account for it -- Claude working through the shell.
 *  See git/gitStatus.ts for how these are noticed and why they're only ever
 *  listed, never diffed or credited to a turn's commands. */
export interface ShellChange {
  /** Absolute path. */
  filePath: string;
  /** Git's XY status letters, verbatim. */
  status: string;
  /** When it was first noticed. */
  at: number;
}

export interface AgentSession {
  /** The terminal's hook/review token: one entry per terminal. */
  token: string;
  /** Claude Code's own session id; changes on /clear. Null until a payload carried one. */
  sessionId: string | null;
  /** False once SessionEnd fired, the shell exited or the terminal closed. */
  running: boolean;
  status: AgentStatus;
  /** Set only while `status` is `needs-attention`, and only when the payload said which. */
  needs: NeedsKind | null;
  /** What Claude asked for ("Claude needs your permission to use Bash"),
   *  while `status` is `needs-attention` and the payload carried one. */
  needsMessage: string | null;
  /** Claude's closing message from the last turn, truncated. */
  lastMessage: string | null;
  turnStartedAt: number | null;
  /** How long the last finished turn took. */
  lastTurnMs: number | null;
  /** When the last turn finished (Stop or StopFailure). */
  lastTurnEndedAt: number | null;
  /** The last file Claude edited in the current turn; cleared when the turn ends. */
  currentFile: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  /** The last turn ended in an error (StopFailure) rather than a Stop;
   *  lastMessage then holds the error. */
  lastTurnFailed: boolean;
  /** The git branch of `cwd`, read at SessionStart and on Stop. Null outside
   *  a repo, with git missing, or before the first read. */
  branch: string | null;
  endedAt: number | null;
  /** The lead's own usage from its transcript, as of the last read
   *  (subagents' are on their runs). Null before one, or when Claude Code
   *  isn't saving transcripts. */
  usage: UsageTotals | null;
  /** The custom agent the session itself runs as (`claude --agent`), or
   *  null for a plain session. */
  agentName: string | null;
  /** Subagents this session started, oldest first. Empty unless subagents
   *  are tracked (Multi-agent, "Track subagents" on). */
  subagents: SubagentRun[];
  /** The session's turns, oldest first; see TurnRecord. Populated from
   *  UserPromptSubmit (Multi-agent) and from the prompt_id its edits carry,
   *  so in Classic there are turns but no prompt text. Capped at MAX_TURNS. */
  turns: TurnRecord[];
  /** Files changed outside Claude's edit tools this session, newest last;
   *  see ShellChange. Empty when the folder isn't a git repo or the setting
   *  is off. */
  shellChanges: ShellChange[];
}

/** One subagent run inside a session. Subagents run in the lead's `claude`
 *  process, so they share its terminal and token; `agentId` is what tells
 *  their edits apart (see PendingChange.agents). */
export interface SubagentRun {
  agentId: string;
  /** e.g. "general-purpose", "Explore"; a teammate's name for an
   *  agent-team teammate. */
  agentType: string;
  /** An agent-team teammate rather than a subagent: it can sit idle and
   *  take more messages, and turn-end task lists don't name it by id. */
  teammate: boolean;
  /** The task the lead gave it ("Check token rotation"). Null when it
   *  couldn't be matched to the lead's Agent call; show the type instead. */
  description: string | null;
  running: boolean;
  /** How it ended; null while running. */
  outcome: SubagentOutcome | null;
  /** The readable error, for a failed run. */
  error: string | null;
  /** Listed in a background_tasks list at some point: only a run known to
   *  be in the background can be judged stopped by its absence from one. */
  seenInBackground: boolean;
  startedAt: number;
  endedAt: number | null;
  lastMessage: string | null;
  transcriptPath: string | null;
  /** From its own transcript, as of the last read; null before one. */
  usage: UsageTotals | null;
}

/**
 * - `done`: SubagentStop.
 * - `failed`: StopFailure with its agent_id (an API error, captured from
 *   2.1.296); no SubagentStop follows.
 * - `stopped`: it dropped out of the running background tasks with neither
 *   of those, as a subagent the lead stops with TaskStop does (no hook
 *   reports that), or its session ended.
 */
export type SubagentOutcome = "done" | "failed" | "stopped";

/** A background task as Stop and SubagentStop list them. */
export interface ReportedBackgroundTask {
  id: string;
  type: string;
  description?: string;
}

/** The lead's Agent tool call, waiting for the SubagentStart it causes. */
interface AgentLaunch {
  description: string | null;
  agentType: string | null;
  /** An agent-team teammate's name, which its SubagentStart reports as
   *  the type. */
  name: string | null;
}

/** Ample for any card; keeps a long-running session from growing without
 *  bound. Finished runs go first. */
const MAX_SUBAGENTS = 50;

/** Ample for any card, and keeps a session left running for days from
 *  growing without bound. The open turn is never dropped. */
const MAX_TURNS = 50;

const MAX_MESSAGE_LENGTH = 500;

/** A turn's prompt is kept far longer than a closing message: it is the one
 *  thing that says what the turn was for, it is what the card's hover shows
 *  in full, and it is what the session log writes down. 500 characters cut
 *  a normal multi-paragraph request in half. */
const MAX_PROMPT_LENGTH = 2000;

type AgentSessionStoreEvents = {
  change: [AgentSession];
};

interface SessionIdentity {
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

/**
 * Plugin-wide status of the Claude session running in each terminal, built
 * only from hook events (and the terminal's own lifecycle) -- nothing here
 * polls. Keyed by terminal token rather than Claude's session id, since a
 * terminal is what the user sees and /clear swaps the session id under it.
 *
 * Every event creates its terminal's entry if needed: in Classic there's no
 * SessionStart hook, so a Stop or a file edit is the first sign of Claude.
 */
export class AgentSessionStore extends TypedEmitter<AgentSessionStoreEvents> {
  private sessions = new Map<string, AgentSession>();
  /** Per terminal: Agent calls not yet matched to a SubagentStart. */
  private launches = new Map<string, AgentLaunch[]>();

  get(token: string): AgentSession | undefined {
    return this.sessions.get(token);
  }

  list(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** SessionStart. A new session id under the same terminal (/clear, or a
   *  fresh `claude` after the last one exited) starts from a clean slate. */
  sessionStarted(token: string, identity: SessionIdentity, agentName?: string): void {
    const existing = this.sessions.get(token);
    const isNewSession = !existing || !existing.running || (identity.sessionId !== undefined && identity.sessionId !== existing.sessionId);
    const base = isNewSession ? this.blank(token) : existing;
    if (isNewSession) this.launches.delete(token);
    this.update({ ...base, ...this.identityFields(base, identity), running: true, endedAt: null, agentName: agentName?.trim() || base.agentName });
  }

  /** UserPromptSubmit: a turn starts. `prompt` and `promptId` come straight
   *  from the payload; without a promptId there's nothing to key the turn
   *  by, so only the status fields move. */
  promptSubmitted(token: string, identity: SessionIdentity, prompt?: string, promptId?: string, at = Date.now()): void {
    const s = this.ensure(token, identity);
    this.update({
      ...s,
      status: "working",
      needs: null,
      needsMessage: null,
      turnStartedAt: at,
      currentFile: null,
      turns: promptId ? openTurn(s.turns, promptId, prompt, at) : s.turns,
    });
  }

  /** PreToolUse on a file edit: Claude is working, so any permission prompt
   *  it was waiting on has been answered. */
  fileEdited(token: string, filePath: string, identity: SessionIdentity, promptId?: string): void {
    const s = this.ensure(token, identity);
    const at = Date.now();
    this.update({
      ...s,
      status: "working",
      needs: null,
      needsMessage: null,
      currentFile: filePath,
      turnStartedAt: s.turnStartedAt ?? at,
      // In Classic there's no UserPromptSubmit hook, so an edit is the
      // first thing that names its turn; in Multi-agent the turn is
      // already on record and this is a no-op.
      turns: promptId ? openTurn(s.turns, promptId, undefined, at) : s.turns,
    });
  }

  /** The lead called the Agent tool. SubagentStart doesn't carry the task
   *  description, so this is queued for the start it's about to cause. */
  agentLaunched(token: string, description: string | undefined, agentType: string | undefined, name?: string): void {
    const queue = this.launches.get(token) ?? [];
    queue.push({ description: description?.trim() || null, agentType: agentType ?? null, name: name?.trim() || null });
    this.launches.set(token, queue);
  }

  /** SubagentStart. In captured runs it lands right after the Agent call
   *  that caused it, for foreground and background subagents alike, so it
   *  takes the oldest queued launch of its type, or failing that one that
   *  named no type (the Agent call can omit subagent_type). With neither,
   *  the run shows its type alone. */
  subagentStarted(token: string, agentId: string, agentType: string, identity: SessionIdentity, at = Date.now()): void {
    const s = this.ensure(token, identity);
    if (s.subagents.some((run) => run.agentId === agentId)) return;
    const launch = this.takeLaunch(token, agentType);
    const run: SubagentRun = {
      agentId,
      agentType,
      teammate: launch?.name === agentType,
      description: launch?.description ?? null,
      running: true,
      outcome: null,
      error: null,
      seenInBackground: false,
      startedAt: at,
      endedAt: null,
      lastMessage: null,
      transcriptPath: null,
      usage: null,
    };
    this.update({ ...s, subagents: capSubagents([...s.subagents, run]) });
  }

  /** SubagentStop (`done`) or a subagent's StopFailure (`failed`). A
   *  SubagentStop's background_tasks list the stopping subagent with its
   *  description, which settles any guess made at the start. An end that
   *  arrives after the run was judged stopped (see backgroundTasksReported)
   *  overrides that judgement. */
  subagentEnded(
    token: string,
    end: {
      agentId: string;
      agentType: string;
      outcome: "done" | "failed";
      lastMessage?: string;
      error?: string;
      transcriptPath?: string;
      description?: string;
    },
    identity: SessionIdentity,
    at = Date.now()
  ): void {
    const s = this.ensure(token, identity);
    const existing = s.subagents.find((run) => run.agentId === end.agentId);
    // Claude Code's internal helpers (a prompt suggestion: "commit this")
    // send a SubagentStop with no start and the session's own agent type:
    // none for a plain session, "reviewer" under `claude --agent reviewer`.
    // They aren't subagents anyone started.
    if (!existing && (!end.agentType.trim() || end.agentType === s.agentName)) return;
    // A stop with no start on record: the start landed before Terminus
    // loaded, or the hooks were installed mid-run.
    const base: SubagentRun = existing ?? {
      agentId: end.agentId,
      agentType: end.agentType,
      teammate: false,
      description: null,
      running: true,
      outcome: null,
      error: null,
      seenInBackground: false,
      startedAt: at,
      endedAt: null,
      lastMessage: null,
      transcriptPath: null,
      usage: null,
    };
    const run: SubagentRun = {
      ...base,
      description: end.description?.trim() || base.description,
      running: false,
      outcome: end.outcome,
      error: end.outcome === "failed" ? truncate(end.error || end.lastMessage || "Failed") : null,
      endedAt: base.running || base.endedAt === null ? at : base.endedAt,
      lastMessage: end.lastMessage === undefined ? base.lastMessage : truncate(end.lastMessage),
      transcriptPath: end.transcriptPath ?? base.transcriptPath,
    };
    const subagents = existing ? s.subagents.map((r) => (r === existing ? run : r)) : capSubagents([...s.subagents, run]);
    this.update({ ...s, subagents });
  }

  /**
   * Stop and SubagentStop list the background tasks still running. A
   * subagent stopped by the lead (TaskStop) sends no hook of its own, so a
   * running subagent missing from a list is judged stopped -- from any list
   * if it was listed before, and from Stop's even if not: the lead waits for
   * a foreground subagent, so at Stop every running one is a background
   * one. Undefined `tasks` (a bridge that sent no body) tells nothing.
   */
  backgroundTasksReported(token: string, tasks: ReportedBackgroundTask[] | undefined, atTurnEnd: boolean, at = Date.now()): void {
    if (!tasks) return;
    const s = this.sessions.get(token);
    if (!s || s.subagents.length === 0) return;
    const listed = new Map(tasks.filter((t) => t.type === "subagent").map((t) => [t.id, t]));
    let changed = false;
    const subagents = s.subagents.map((run) => {
      const task = listed.get(run.agentId);
      if (task) {
        const description = run.description ?? (task.description?.trim() || null);
        if (run.seenInBackground && description === run.description) return run;
        changed = true;
        return { ...run, seenInBackground: true, description };
      }
      // Teammates are listed as "teammate" tasks under task ids, not their
      // agent ids, so their absence says nothing; they end with their own
      // SubagentStop, or with the session.
      if (!run.running || run.teammate || !(atTurnEnd || run.seenInBackground)) return run;
      changed = true;
      return { ...run, running: false, outcome: "stopped" as const, endedAt: at };
    });
    if (changed) this.update({ ...s, subagents });
  }

  /** The turn still waiting on its Stop, if there is one.
   *
   *  A StopFailure has not been confirmed to carry a prompt_id (see
   *  hooks/types.ts), and everything downstream of it -- which turn to close,
   *  which turn's edits to write into the session log -- needs to know which
   *  turn it ended. Asked here, while the turn is still open, rather than
   *  guessed separately by each of them afterwards. Same rule as closeTurn's
   *  own fallback: the newest turn that has not ended. */
  openTurnId(token: string): string | undefined {
    const turns = this.sessions.get(token)?.turns;
    if (!turns) return undefined;
    return [...turns].reverse().find((turn) => turn.endedAt === null)?.promptId;
  }

  /** The lead's StopFailure: the turn ended in an error, with no Stop. */
  turnFailed(token: string, error: string | undefined, identity: SessionIdentity, at = Date.now(), promptId?: string): void {
    this.turnEnded(token, error ?? "The turn ended with an error.", identity, at, true, promptId);
  }

  /** Stop: the turn is over. */
  turnEnded(token: string, lastMessage: string | undefined, identity: SessionIdentity, at = Date.now(), failed = false, promptId?: string): void {
    // Every launch has had its SubagentStart by now (it follows the Agent
    // call at once); one left over was denied, so it must not be matched to
    // a later turn's subagent.
    this.launches.delete(token);
    const s = this.ensure(token, identity);
    this.update({
      ...s,
      status: "finished-unread",
      needs: null,
      needsMessage: null,
      lastTurnFailed: failed,
      currentFile: null,
      lastMessage: lastMessage === undefined ? s.lastMessage : truncate(lastMessage),
      lastTurnMs: s.turnStartedAt === null ? s.lastTurnMs : at - s.turnStartedAt,
      lastTurnEndedAt: at,
      turnStartedAt: null,
      turns: closeTurn(s.turns, promptId, at, failed),
    });
  }

  /** Notification: Claude needs permission or is waiting on input. */
  needsAttention(token: string, notificationType: string | undefined, message: string | undefined, identity: SessionIdentity): void {
    const s = this.ensure(token, identity);
    let needs = needsKindOf(notificationType);
    // Claude Code sends idle_prompt about a minute after every finished turn
    // (seen in a live 2.1.296 session). A turn nobody has looked at yet is
    // escalated; one already looked at stays in Finished, or every finished
    // session would end up in Needs attention.
    if (notificationType === "idle_prompt" && s.status !== "working") {
      if (s.status !== "finished-unread") return;
      needs = "unread-turn";
    }
    this.update({ ...s, status: "needs-attention", needs, needsMessage: message?.trim() || null });
  }

  /**
   * The user answered an open prompt in the terminal (see TerminalView's
   * answer keys). No hook reports a denied or cancelled permission prompt,
   * and an approval only after the tool has finished, so the keystroke is
   * the earliest signal. `proceed` (Enter or an option number) assumes the
   * common case, an approval, and the next hook corrects it; `cancel` (Esc
   * or Ctrl+C) means the turn was interrupted.
   */
  promptAnswered(token: string, answer: "proceed" | "cancel"): void {
    const s = this.sessions.get(token);
    // An unread turn is cleared by seen() instead: typing there is a new prompt.
    if (!s || s.status !== "needs-attention" || s.needs === "unread-turn") return;
    if (answer === "proceed") {
      this.update({ ...s, status: "working", needs: null, needsMessage: null, turnStartedAt: s.turnStartedAt ?? Date.now() });
    } else {
      this.update({ ...s, status: "idle", needs: null, needsMessage: null, currentFile: null, turnStartedAt: null });
    }
  }

  /** Usage read from the lead's transcript. */
  usageRead(token: string, usage: UsageTotals | null): void {
    const s = this.sessions.get(token);
    if (!s || sameUsage(s.usage, usage)) return;
    this.update({ ...s, usage });
  }

  /** Usage read from a subagent's transcript. */
  subagentUsageRead(token: string, agentId: string, usage: UsageTotals | null): void {
    const s = this.sessions.get(token);
    const run = s?.subagents.find((r) => r.agentId === agentId);
    if (!s || !run || sameUsage(run.usage, usage)) return;
    this.update({ ...s, subagents: s.subagents.map((r) => (r === run ? { ...r, usage } : r)) });
  }

  /** The shell-changed files for this session, as TerminalView worked them
   *  out at a turn's end (it holds the git snapshots and the set of files
   *  the edit hooks accounted for). Replaces the list wholesale: the caller
   *  has already merged in what's new and dropped what's no longer dirty. */
  shellChangesRead(token: string, shellChanges: ShellChange[]): void {
    const s = this.sessions.get(token);
    if (!s || sameShellChanges(s.shellChanges, shellChanges)) return;
    this.update({ ...s, shellChanges });
  }

  /** The git branch read for this session's folder; see AgentSession.branch. */
  branchRead(token: string, branch: string | null): void {
    const s = this.sessions.get(token);
    if (!s || s.branch === branch) return;
    this.update({ ...s, branch });
  }

  /** The user looked at the terminal: a finished turn counts as read,
   *  including one escalated by idle_prompt. A prompt that needs an answer
   *  still does until it's answered or Claude moves on. */
  seen(token: string): void {
    const s = this.sessions.get(token);
    if (!s) return;
    const unreadTurn = s.status === "finished-unread" || (s.status === "needs-attention" && s.needs === "unread-turn");
    if (!unreadTurn) return;
    this.update({ ...s, status: "idle", needs: null, needsMessage: null });
  }

  /** SessionEnd, the shell exiting, or the terminal closing -- SessionEnd
   *  alone can't be relied on, since a killed shell never sends it. */
  sessionEnded(token: string, at = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s || !s.running) return;
    this.launches.delete(token);
    this.update({
      ...s,
      running: false,
      status: "idle",
      needs: null,
      needsMessage: null,
      currentFile: null,
      turnStartedAt: null,
      endedAt: at,
      // Subagents live in the lead's process, so they've ended with it.
      subagents: s.subagents.map((run) => (run.running ? { ...run, running: false, outcome: "stopped" as const, endedAt: at } : run)),
      // Likewise an unfinished turn: the session is gone, so it can't still
      // be running, and leaving it open would have its timer count forever.
      turns: closeTurn(s.turns, undefined, at, false),
    });
  }

  /** Forgets a terminal entirely, for when nothing needs its record any more. */
  remove(token: string): void {
    this.sessions.delete(token);
    this.launches.delete(token);
  }

  private takeLaunch(token: string, agentType: string): AgentLaunch | undefined {
    const queue = this.launches.get(token);
    if (!queue || queue.length === 0) return undefined;
    // A teammate's type is the name its launch gave it.
    let index = queue.findIndex((launch) => launch.name === agentType);
    if (index === -1) index = queue.findIndex((launch) => launch.agentType === agentType);
    if (index === -1) index = queue.findIndex((launch) => launch.agentType === null);
    if (index === -1) return undefined;
    const [launch] = queue.splice(index, 1);
    return launch;
  }

  private ensure(token: string, identity: SessionIdentity): AgentSession {
    const existing = this.sessions.get(token);
    // A session that ended and then shows activity again is a new `claude`
    // started in the same terminal without a SessionStart (Classic).
    const base = existing && existing.running ? existing : this.blank(token);
    return { ...base, ...this.identityFields(base, identity), running: true, endedAt: null };
  }

  private identityFields(base: AgentSession, identity: SessionIdentity): Pick<AgentSession, "sessionId" | "transcriptPath" | "cwd"> {
    return {
      sessionId: identity.sessionId ?? base.sessionId,
      transcriptPath: identity.transcriptPath ?? base.transcriptPath,
      cwd: identity.cwd ?? base.cwd,
    };
  }

  private blank(token: string): AgentSession {
    return {
      token,
      sessionId: null,
      running: true,
      status: "idle",
      needs: null,
      needsMessage: null,
      lastMessage: null,
      lastTurnFailed: false,
      turnStartedAt: null,
      lastTurnMs: null,
      lastTurnEndedAt: null,
      agentName: null,
      currentFile: null,
      transcriptPath: null,
      cwd: null,
      branch: null,
      endedAt: null,
      usage: null,
      subagents: [],
      turns: [],
      shellChanges: [],
    };
  }

  private update(session: AgentSession): void {
    this.sessions.set(session.token, session);
    this.emit("change", session);
  }
}

function sameUsage(a: UsageTotals | null, b: UsageTotals | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameShellChanges(a: ShellChange[], b: ShellChange[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * How long the session has actually been working: its turns' durations
 * added up, with the open turn reported separately so the card can tick it
 * up in place. Deliberately not the wall clock from the first turn to the
 * last -- that counts every gap where the session sat idle waiting for the
 * user, which on one left open over lunch is nearly all of it.
 */
export function activeTime(session: AgentSession): { finishedMs: number; runningSince: number | null } {
  let finishedMs = 0;
  let runningSince: number | null = null;
  for (const turn of session.turns) {
    if (turn.endedAt === null) runningSince = turn.startedAt;
    else finishedMs += turn.endedAt - turn.startedAt;
  }
  return { finishedMs, runningSince };
}

/** Records the turn `promptId` names, keeping turns oldest-first. One
 *  already on record stays where it is -- its edits keep arriving after it
 *  was first seen -- and only gains its prompt text if that wasn't known
 *  yet (an edit names a turn without carrying the prompt). */
function openTurn(turns: TurnRecord[], promptId: string, prompt: string | undefined, at: number): TurnRecord[] {
  const text = prompt?.trim() ? truncateTo(prompt, MAX_PROMPT_LENGTH) : null;
  const existing = turns.find((turn) => turn.promptId === promptId);
  if (existing) {
    if (!text || existing.prompt) return turns;
    return turns.map((turn) => (turn === existing ? { ...turn, prompt: text } : turn));
  }
  return capTurns([...turns, { promptId, prompt: text, startedAt: at, endedAt: null, failed: false }]);
}

/** Closes the turn `promptId` names or, with no id (a StopFailure, which
 *  hasn't been confirmed to carry one), whichever turn is still open. */
function closeTurn(turns: TurnRecord[], promptId: string | undefined, at: number, failed: boolean): TurnRecord[] {
  const open = [...turns].reverse().find((turn) => turn.endedAt === null);
  const target = promptId ? turns.find((turn) => turn.promptId === promptId) : open;
  if (!target || target.endedAt !== null) return turns;
  return turns.map((turn) => (turn === target ? { ...turn, endedAt: at, failed } : turn));
}

function capTurns(turns: TurnRecord[]): TurnRecord[] {
  let excess = turns.length - MAX_TURNS;
  if (excess <= 0) return turns;
  return turns.filter((turn) => turn.endedAt === null || excess-- <= 0);
}

function capSubagents(runs: SubagentRun[]): SubagentRun[] {
  let excess = runs.length - MAX_SUBAGENTS;
  if (excess <= 0) return runs;
  return runs.filter((run) => run.running || excess-- <= 0);
}

function needsKindOf(notificationType: string | undefined): NeedsKind | null {
  if (notificationType === "permission_prompt") return "permission";
  if (notificationType === "idle_prompt") return "input";
  return null;
}

function truncate(text: string): string {
  return truncateTo(text, MAX_MESSAGE_LENGTH);
}

function truncateTo(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
