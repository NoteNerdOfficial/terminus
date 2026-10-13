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
  /** Subagents this session started, oldest first. Empty unless subagents
   *  are tracked (Multi-agent, "Track subagents" on). */
  subagents: SubagentRun[];
}

/** One subagent run inside a session. Subagents run in the lead's `claude`
 *  process, so they share its terminal and token; `agentId` is what tells
 *  their edits apart (see PendingChange.agents). */
export interface SubagentRun {
  agentId: string;
  /** e.g. "general-purpose", "Explore". */
  agentType: string;
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
}

/** Ample for any card; keeps a long-running session from growing without
 *  bound. Finished runs go first. */
const MAX_SUBAGENTS = 50;

const MAX_MESSAGE_LENGTH = 500;

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
  sessionStarted(token: string, identity: SessionIdentity): void {
    const existing = this.sessions.get(token);
    const isNewSession = !existing || !existing.running || (identity.sessionId !== undefined && identity.sessionId !== existing.sessionId);
    const base = isNewSession ? this.blank(token) : existing;
    if (isNewSession) this.launches.delete(token);
    this.update({ ...base, ...this.identityFields(base, identity), running: true, endedAt: null });
  }

  /** UserPromptSubmit: a turn starts. */
  promptSubmitted(token: string, identity: SessionIdentity, at = Date.now()): void {
    const s = this.ensure(token, identity);
    this.update({ ...s, status: "working", needs: null, needsMessage: null, turnStartedAt: at, currentFile: null });
  }

  /** PreToolUse on a file edit: Claude is working, so any permission prompt
   *  it was waiting on has been answered. */
  fileEdited(token: string, filePath: string, identity: SessionIdentity): void {
    const s = this.ensure(token, identity);
    this.update({ ...s, status: "working", needs: null, needsMessage: null, currentFile: filePath, turnStartedAt: s.turnStartedAt ?? Date.now() });
  }

  /** The lead called the Agent tool. SubagentStart doesn't carry the task
   *  description, so this is queued for the start it's about to cause. */
  agentLaunched(token: string, description: string | undefined, agentType: string | undefined): void {
    const queue = this.launches.get(token) ?? [];
    queue.push({ description: description?.trim() || null, agentType: agentType ?? null });
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
    const run: SubagentRun = {
      agentId,
      agentType,
      description: this.takeLaunch(token, agentType)?.description ?? null,
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
    // Claude Code's internal helpers send a SubagentStop with no type and no
    // start; they aren't subagents anyone started.
    if (!existing && !end.agentType.trim()) return;
    // A stop with no start on record: the start landed before Terminus
    // loaded, or the hooks were installed mid-run.
    const base: SubagentRun = existing ?? {
      agentId: end.agentId,
      agentType: end.agentType,
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
      if (!run.running || !(atTurnEnd || run.seenInBackground)) return run;
      changed = true;
      return { ...run, running: false, outcome: "stopped" as const, endedAt: at };
    });
    if (changed) this.update({ ...s, subagents });
  }

  /** The lead's StopFailure: the turn ended in an error, with no Stop. */
  turnFailed(token: string, error: string | undefined, identity: SessionIdentity, at = Date.now()): void {
    this.turnEnded(token, error ?? "The turn ended with an error.", identity, at, true);
  }

  /** Stop: the turn is over. */
  turnEnded(token: string, lastMessage: string | undefined, identity: SessionIdentity, at = Date.now(), failed = false): void {
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
      turnStartedAt: null,
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
    let index = queue.findIndex((launch) => launch.agentType === agentType);
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
      currentFile: null,
      transcriptPath: null,
      cwd: null,
      branch: null,
      endedAt: null,
      usage: null,
      subagents: [],
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
  const trimmed = text.trim();
  return trimmed.length > MAX_MESSAGE_LENGTH ? `${trimmed.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : trimmed;
}
