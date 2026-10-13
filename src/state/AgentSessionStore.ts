import { TypedEmitter } from "../node/emitter";

/**
 * - `working`: Claude is mid-turn.
 * - `needs-attention`: Claude asked for permission, or is waiting on input.
 * - `finished-unread`: the turn ended and nobody has looked at the terminal since.
 * - `idle`: the turn ended and the terminal has been looked at since, or no turn yet.
 */
export type AgentStatus = "working" | "needs-attention" | "finished-unread" | "idle";

/** Why a session needs attention, when the Notification payload says. */
export type NeedsKind = "permission" | "input";

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
  /** The git branch of `cwd`, read at SessionStart and on Stop. Null outside
   *  a repo, with git missing, or before the first read. */
  branch: string | null;
  endedAt: number | null;
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
  startedAt: number;
  endedAt: number | null;
  lastMessage: string | null;
  transcriptPath: string | null;
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
      startedAt: at,
      endedAt: null,
      lastMessage: null,
      transcriptPath: null,
    };
    this.update({ ...s, subagents: capSubagents([...s.subagents, run]) });
  }

  /** SubagentStop. Its background_tasks list the stopping subagent with its
   *  description, which settles any guess made at the start. */
  subagentStopped(
    token: string,
    stop: { agentId: string; agentType: string; lastMessage?: string; transcriptPath?: string; description?: string },
    identity: SessionIdentity,
    at = Date.now()
  ): void {
    const s = this.ensure(token, identity);
    const existing = s.subagents.find((run) => run.agentId === stop.agentId);
    // A stop with no start on record: the start landed before Terminus
    // loaded, or the hooks were installed mid-run.
    const base: SubagentRun = existing ?? {
      agentId: stop.agentId,
      agentType: stop.agentType,
      description: null,
      running: true,
      startedAt: at,
      endedAt: null,
      lastMessage: null,
      transcriptPath: null,
    };
    const run: SubagentRun = {
      ...base,
      description: stop.description?.trim() || base.description,
      running: false,
      endedAt: at,
      lastMessage: stop.lastMessage === undefined ? base.lastMessage : truncate(stop.lastMessage),
      transcriptPath: stop.transcriptPath ?? base.transcriptPath,
    };
    const subagents = existing ? s.subagents.map((r) => (r === existing ? run : r)) : capSubagents([...s.subagents, run]);
    this.update({ ...s, subagents });
  }

  /** Stop: the turn is over. */
  turnEnded(token: string, lastMessage: string | undefined, identity: SessionIdentity, at = Date.now()): void {
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
      currentFile: null,
      lastMessage: lastMessage === undefined ? s.lastMessage : truncate(lastMessage),
      lastTurnMs: s.turnStartedAt === null ? s.lastTurnMs : at - s.turnStartedAt,
      turnStartedAt: null,
    });
  }

  /** Notification: Claude needs permission or is waiting on input. */
  needsAttention(token: string, notificationType: string | undefined, message: string | undefined, identity: SessionIdentity): void {
    const s = this.ensure(token, identity);
    // Claude Code sends idle_prompt about a minute after every finished turn
    // (seen in a live 2.1.296 session). After a Stop that's no news: the
    // card already says Finished, and moving every finished session into
    // Needs attention would empty the Finished section.
    if (notificationType === "idle_prompt" && s.status !== "working") return;
    this.update({ ...s, status: "needs-attention", needs: needsKindOf(notificationType), needsMessage: message?.trim() || null });
  }

  /** The git branch read for this session's folder; see AgentSession.branch. */
  branchRead(token: string, branch: string | null): void {
    const s = this.sessions.get(token);
    if (!s || s.branch === branch) return;
    this.update({ ...s, branch });
  }

  /** The user looked at the terminal: a finished turn counts as read. A
   *  session that needs attention still does until Claude moves on. */
  seen(token: string): void {
    const s = this.sessions.get(token);
    if (!s || s.status !== "finished-unread") return;
    this.update({ ...s, status: "idle" });
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
      subagents: s.subagents.map((run) => (run.running ? { ...run, running: false, endedAt: at } : run)),
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
      turnStartedAt: null,
      lastTurnMs: null,
      currentFile: null,
      transcriptPath: null,
      cwd: null,
      branch: null,
      endedAt: null,
      subagents: [],
    };
  }

  private update(session: AgentSession): void {
    this.sessions.set(session.token, session);
    this.emit("change", session);
  }
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
