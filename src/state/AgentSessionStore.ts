import { TypedEmitter } from "../node/emitter";

/**
 * - `working`: Claude is mid-turn.
 * - `needs-you`: Claude asked for permission, or is waiting on input.
 * - `finished-unread`: the turn ended and nobody has looked at the terminal since.
 * - `idle`: the turn ended and the terminal has been looked at since, or no turn yet.
 */
export type AgentStatus = "working" | "needs-you" | "finished-unread" | "idle";

/** Why a session needs you, when the Notification payload says. */
export type NeedsKind = "permission" | "input";

export interface AgentSession {
  /** The terminal's hook/review token: one entry per terminal. */
  token: string;
  /** Claude Code's own session id; changes on /clear. Null until a payload carried one. */
  sessionId: string | null;
  /** False once SessionEnd fired, the shell exited or the terminal closed. */
  running: boolean;
  status: AgentStatus;
  /** Set only while `status` is `needs-you`, and only when the payload said which. */
  needs: NeedsKind | null;
  /** Claude's closing message from the last turn, truncated. */
  lastMessage: string | null;
  turnStartedAt: number | null;
  /** How long the last finished turn took. */
  lastTurnMs: number | null;
  /** The last file Claude edited in the current turn; cleared when the turn ends. */
  currentFile: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  endedAt: number | null;
}

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
    this.update({ ...base, ...this.identityFields(base, identity), running: true, endedAt: null });
  }

  /** UserPromptSubmit: a turn starts. */
  promptSubmitted(token: string, identity: SessionIdentity, at = Date.now()): void {
    const s = this.ensure(token, identity);
    this.update({ ...s, status: "working", needs: null, turnStartedAt: at, currentFile: null });
  }

  /** PreToolUse on a file edit: Claude is working, so any permission prompt
   *  it was waiting on has been answered. */
  fileEdited(token: string, filePath: string, identity: SessionIdentity): void {
    const s = this.ensure(token, identity);
    this.update({ ...s, status: "working", needs: null, currentFile: filePath, turnStartedAt: s.turnStartedAt ?? Date.now() });
  }

  /** Stop: the turn is over. */
  turnEnded(token: string, lastMessage: string | undefined, identity: SessionIdentity, at = Date.now()): void {
    const s = this.ensure(token, identity);
    this.update({
      ...s,
      status: "finished-unread",
      needs: null,
      currentFile: null,
      lastMessage: lastMessage === undefined ? s.lastMessage : truncate(lastMessage),
      lastTurnMs: s.turnStartedAt === null ? s.lastTurnMs : at - s.turnStartedAt,
      turnStartedAt: null,
    });
  }

  /** Notification: Claude needs permission or is waiting on input. */
  needsAttention(token: string, notificationType: string | undefined, identity: SessionIdentity): void {
    const s = this.ensure(token, identity);
    this.update({ ...s, status: "needs-you", needs: needsKindOf(notificationType) });
  }

  /** The user looked at the terminal: a finished turn counts as read. A
   *  session that needs you still does until Claude moves on. */
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
    this.update({ ...s, running: false, status: "idle", needs: null, currentFile: null, turnStartedAt: null, endedAt: at });
  }

  /** Forgets a terminal entirely, for when nothing needs its record any more. */
  remove(token: string): void {
    this.sessions.delete(token);
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
      lastMessage: null,
      turnStartedAt: null,
      lastTurnMs: null,
      currentFile: null,
      transcriptPath: null,
      cwd: null,
      endedAt: null,
    };
  }

  private update(session: AgentSession): void {
    this.sessions.set(session.token, session);
    this.emit("change", session);
  }
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
