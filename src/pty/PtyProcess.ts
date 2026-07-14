import { TypedEmitter } from "../node/emitter";
import { spawnWithControlChannel, type SpawnedProcess } from "../node/process";

export interface PtyProcessOptions {
  pythonBin: string;
  helperPath: string;
  shell: string;
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

type ControlMessage =
  | { type: "ready" }
  | { type: "exited"; code: number | null };

type PtyProcessEvents = {
  data: [Buffer];
  ready: [];
  exit: [{ code: number | null }];
  error: [Error];
  stderr: [string];
  helperExited: [number | null];
};

/**
 * Node-side half of the PTY protocol implemented by resources/pty_helper.py.
 * fd0/1 carry raw terminal bytes, fd2 is the helper's own diagnostics, fd3 is
 * a newline-delimited JSON control channel (resize in, ready/exited out).
 *
 * Events: 'data' (Buffer), 'ready' (), 'exit' ({code}), 'error' (Error)
 */
export class PtyProcess extends TypedEmitter<PtyProcessEvents> {
  private child: SpawnedProcess | null = null;
  private controlBuf = "";

  constructor(private opts: PtyProcessOptions) {
    super();
  }

  start(): void {
    const child = spawnWithControlChannel(
      this.opts.pythonBin,
      [
        this.opts.helperPath,
        "--cols",
        String(this.opts.cols),
        "--rows",
        String(this.opts.rows),
        "--shell",
        this.opts.shell,
      ],
      { cwd: this.opts.cwd, env: this.opts.env }
    );
    this.child = child;

    child.onStdout((chunk) => this.emit("data", chunk));
    child.onStderr((chunk) => this.emit("stderr", chunk.toString("utf8")));
    child.onControlData((chunk) => this.handleControlChunk(chunk));
    child.onError((err) => this.emit("error", err));
    child.onClose((code) => this.emit("exit", { code }));
  }

  write(data: string): void {
    this.child?.writeStdin(data);
  }

  resize(cols: number, rows: number): void {
    this.child?.writeControl(JSON.stringify({ type: "resize", cols, rows }) + "\n");
  }

  kill(signal = "SIGTERM"): void {
    this.child?.kill(signal);
  }

  private handleControlChunk(chunk: Buffer): void {
    this.controlBuf += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.controlBuf.indexOf("\n")) !== -1) {
      const line = this.controlBuf.slice(0, idx);
      this.controlBuf = this.controlBuf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as ControlMessage;
        if (msg.type === "ready") this.emit("ready");
        if (msg.type === "exited") this.emit("helperExited", msg.code);
      } catch {
        // ignore malformed control lines
      }
    }
  }
}
