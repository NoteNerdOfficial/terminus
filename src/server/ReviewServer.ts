import { createHttpServer, bufferLength, concatBuffersToString, type SimpleHttpRequest, type SimpleHttpResponse, type SimpleHttpServer } from "terminus-node-bridge";
import { PreToolUseHookPayload } from "../hooks/types";

export interface RegisteredPanel {
  /** Called synchronously within the PreToolUse hook's request/response
   *  cycle, BEFORE Claude's own tool execution writes the file -- this is
   *  what makes it safe to read "current on-disk content" here as the
   *  pre-edit snapshot. Does not wait on a human: the write is allowed to
   *  proceed immediately after this resolves, and review happens after the
   *  fact (see PendingChangesStore) rather than gating the write. */
  onChangeApplied(payload: PreToolUseHookPayload): Promise<void>;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // generous cap for a Write tool's full file content

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
    if (req.method !== "POST" || req.url !== "/review") {
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

    await panel.onChangeApplied(payload);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("");
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
