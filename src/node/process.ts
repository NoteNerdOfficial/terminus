import { execFile, spawn } from "child_process";

export function getEnvVar(name: string): string | undefined {
  return process.env[name];
}

/** A copy of this process's environment, safe to spread into a spawned
 *  child's own env (e.g. `{ ...getAllEnvVars(), FOO: "bar" }`). */
export function getAllEnvVars(): Record<string, string | undefined> {
  return { ...process.env };
}

/** Hand-declared instead of relying on `util.promisify(execFile)`'s own
 *  inferred/overloaded return type -- see src/node/fs.ts's file comment. */
export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export interface ExecFileOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
}

/** What a failed execFileText() rejects with. Same shape the codebase
 *  already narrowed error objects to by hand in a couple of catch blocks
 *  (killed/signal/stderr/code), just declared once, centrally, instead of
 *  intersected with Node's ambient `NodeJS.ErrnoException` at each call site.
 *  A real Error subclass (not a plain object) so rejecting with one follows
 *  normal Promise-rejection conventions. */
export class ExecFileError extends Error {
  killed?: boolean;
  signal?: string | null;
  stderr?: string;
  code?: number | string | null;
}

export function execFileText(command: string, args: string[], options: ExecFileOptions = {}): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error) {
        const errWithFields = error as Error & { killed?: boolean; signal?: string | null; code?: number | string | null };
        const execErr = new ExecFileError(error.message);
        execErr.killed = errWithFields.killed;
        execErr.signal = errWithFields.signal;
        execErr.stderr = typeof stderr === "string" ? stderr : undefined;
        execErr.code = errWithFields.code;
        reject(execErr);
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
  });
}

export interface SpawnedProcess {
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  writeStdin(data: string): void;
  /** The control channel (fd 3) pty_helper.py talks JSON over, if the child
   *  was actually given one (stdio slot 3 as a pipe). */
  onControlData(listener: (chunk: Buffer) => void): void;
  writeControl(data: string): void;
  onError(listener: (err: Error) => void): void;
  onClose(listener: (code: number | null) => void): void;
  kill(signal: string): void;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

/** Always requests a 4-slot stdio pipe array (stdin/stdout/stderr + one
 *  extra control channel), matching resources/pty_helper.py's protocol. */
export function spawnWithControlChannel(command: string, args: string[], options: SpawnOptions): SpawnedProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });

  const controlStream = child.stdio[3];
  const hasControlStream = controlStream !== null && controlStream !== undefined && "on" in controlStream && "write" in controlStream;

  return {
    onStdout: (listener) => {
      child.stdout.on("data", listener);
    },
    onStderr: (listener) => {
      child.stderr.on("data", listener);
    },
    writeStdin: (data) => {
      child.stdin.write(data, "utf8");
    },
    onControlData: (listener) => {
      if (hasControlStream) (controlStream as unknown as NodeJS.ReadableStream).on("data", listener);
    },
    writeControl: (data) => {
      if (hasControlStream) (controlStream as unknown as NodeJS.WritableStream).write(data);
    },
    onError: (listener) => {
      child.on("error", listener);
    },
    onClose: (listener) => {
      child.on("close", listener);
    },
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals);
    },
  };
}
