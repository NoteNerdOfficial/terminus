import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";

export interface PtyProcessOptions {
  pythonBin: string;
  helperPath: string;
  shell: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

type ControlMessage =
  | { type: "ready" }
  | { type: "exited"; code: number | null };

/**
 * Node-side half of the PTY protocol implemented by resources/pty_helper.py.
 * fd0/1 carry raw terminal bytes, fd2 is the helper's own diagnostics, fd3 is
 * a newline-delimited JSON control channel (resize in, ready/exited out).
 *
 * Events: 'data' (Buffer), 'ready' (), 'exit' ({code}), 'error' (Error)
 */
export class PtyProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private controlBuf = "";

  constructor(private opts: PtyProcessOptions) {
    super();
  }

  start(): void {
    const child = spawn(
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
      {
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      }
    ) as ChildProcessWithoutNullStreams;
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.emit("data", chunk));

    child.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    const controlStream = child.stdio[3];
    if (controlStream && "on" in controlStream) {
      (controlStream as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        this.handleControlChunk(chunk);
      });
    }

    child.on("error", (err) => this.emit("error", err));
    child.on("close", (code) => this.emit("exit", { code }));
  }

  write(data: string): void {
    this.child?.stdin.write(data, "utf8");
  }

  resize(cols: number, rows: number): void {
    const controlStream = this.child?.stdio[3];
    if (controlStream && "writable" in controlStream) {
      (controlStream as NodeJS.WritableStream).write(
        JSON.stringify({ type: "resize", cols, rows }) + "\n"
      );
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
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
