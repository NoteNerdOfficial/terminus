import { createHttpServer, bufferLength, concatBuffersToString, type SimpleHttpRequest, type SimpleHttpResponse, type SimpleHttpServer } from "terminus-node-bridge";
import {
  BashToolHookPayload,
  FileToolHookPayload,
  NotificationHookPayload,
  PreToolUseHookPayload,
  SessionEventHookPayload,
  StopHookPayload,
  isBashPayload,
} from "../hooks/types";

export interface RegisteredPanel {
  /** Called synchronously within the PreToolUse hook's request/response
   *  cycle, BEFORE Claude's own tool execution writes the file -- this is
   *  what makes it safe to read "current on-disk content" here as the
   *  pre-edit snapshot. Does not wait on a human: the write is allowed to
   *  proceed immediately after this resolves, and review happens after the
   *  fact (see PendingChangesStore) rather than gating the write. */
  onChangeApplied(payload: FileToolHookPayload): Promise<void>;

  /** Called from the Bash hooks, which fire in a PreToolUse/PostToolUse
   *  pair around every shell command. A command's effect isn't in its
   *  payload the way an Edit's is, so the pre call snapshots the files it
   *  looks like it will write and the post call records what actually
   *  changed -- that pair is what gives a `cat > note.md` row the same
   *  diff and Reject as a Write's. */
  onShellCommand(payload: BashToolHookPayload): Promise<void>;

  /** Called from the Stop hook when Claude finishes a turn in this panel --
   *  the one signal that says "no more writes are coming", which nothing in
   *  the PreToolUse stream can express. The payload (for the closing
   *  message) is undefined when the bridge sent no body, as bridges from
   *  before 1.0.36 don't: the fact that it fired is still the message. */
  onTurnEnd(payload: StopHookPayload | undefined): void;

  /** Called from the Notification hook, which Claude Code fires both when
   *  it needs the user's permission to use a tool and when it's been idle
   *  waiting on input -- both are "this panel needs attention" moments, so
   *  any firing raises attention. The payload, when present, says which of
   *  the two it was; undefined for a bodyless call, like onTurnEnd. */
  onNeedsAttention(payload: NotificationHookPayload | undefined): void;

  /** SessionStart, SessionEnd, UserPromptSubmit and StopFailure, plus the lead's Agent
   *  tool call, SubagentStart and SubagentStop when subagents are tracked --
   *  all from the session-event bridge, installed only in the Multi-agent
   *  experience. */
  onSessionEvent(payload: SessionEventHookPayload): void;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // generous cap for a Write tool's full file content
// Status payloads are small; Stop's closing message is the largest field.
const STATUS_BODY_MAX_BYTES = 1024 * 1024;

const SESSION_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "StopFailure"]);
const SUBAGENT_EVENTS = new Set(["SubagentStart", "SubagentStop"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

function isSessionEvent(value: unknown): value is SessionEventHookPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: unknown; agent_id?: unknown };
  if (typeof v.hook_event_name !== "string") return false;
  if (SESSION_EVENTS.has(v.hook_event_name)) return true;
  // The rest feed subagent attribution, which needs the fields checked here.
  if (SUBAGENT_EVENTS.has(v.hook_event_name)) return typeof v.agent_id === "string";
  return (
    v.hook_event_name === "PreToolUse" &&
    typeof v.tool_name === "string" &&
    AGENT_TOOLS.has(v.tool_name) &&
    typeof v.tool_input === "object" &&
    v.tool_input !== null
  );
}

/**
 * Single 127.0.0.1-only HTTP server shared by all Terminus panels.
 * Each panel registers its own random per-session token, so one crashed or
 * closed panel can't affect another's requests.
 */
export class ReviewServer {
  private server: SimpleHttpServer | null = null;
  private panels = new Map<string, RegisteredPanel>();
  private port = 0;

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = createHttpServer((req, res) => {
      this.handleRequest(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
        }
        res.end(`Terminus: internal error: ${errorMessage(err)}`);
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.onError(reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.port = server.getBoundPort() ?? 0;
    return this.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
    this.panels.clear();
  }

  getPort(): number {
    return this.port;
  }

  register(token: string, panel: RegisteredPanel): void {
    this.panels.set(token, panel);
  }

  unregister(token: string): void {
    this.panels.delete(token);
  }

  private async handleRequest(req: SimpleHttpRequest, res: SimpleHttpResponse): Promise<void> {
    if (
      req.method !== "POST" ||
      (req.url !== "/review" && req.url !== "/turn-end" && req.url !== "/notification" && req.url !== "/session-event")
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }

    const auth = req.authorizationHeader ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    const panel = token ? this.panels.get(token) : undefined;
    if (!panel) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("unknown or expired session token");
      return;
    }

    // The status routes never fail the hook over their body: a missing or
    // unreadable one (an older bridge that discards stdin, or a payload
    // shape we don't expect) still delivers the signal itself.
    if (req.url === "/turn-end" || req.url === "/notification" || req.url === "/session-event") {
      const parsed = await readOptionalJson(req, STATUS_BODY_MAX_BYTES);
      if (req.url === "/turn-end") {
        panel.onTurnEnd(parsed as StopHookPayload | undefined);
      } else if (req.url === "/notification") {
        panel.onNeedsAttention(parsed as NotificationHookPayload | undefined);
      } else if (isSessionEvent(parsed)) {
        panel.onSessionEvent(parsed);
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("");
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err: unknown) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end(`request body too large or unreadable: ${errorMessage(err)}`);
      return;
    }

    let payload: PreToolUseHookPayload;
    try {
      payload = JSON.parse(body) as PreToolUseHookPayload;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("invalid JSON payload");
      return;
    }

    if (isBashPayload(payload)) await panel.onShellCommand(payload);
    else await panel.onChangeApplied(payload);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("");
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The body parsed as JSON, or undefined when it's empty, too large or not
 *  JSON. Never rejects. */
async function readOptionalJson(req: SimpleHttpRequest, maxBytes: number): Promise<unknown> {
  try {
    const body = await readBody(req, maxBytes);
    return body.trim() ? (JSON.parse(body) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function readBody(req: SimpleHttpRequest, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.onData((chunk) => {
      total += bufferLength(chunk);
      if (total > maxBytes) {
        reject(new Error("body exceeds max size"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.onEnd(() => resolve(concatBuffersToString(chunks)));
    req.onError(reject);
  });
}
