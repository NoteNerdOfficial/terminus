import type { AgentSession } from "../state/AgentSessionStore";

/** An error the agent API reports to its caller as `{ code, message }`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400
  ) {
    super(message);
  }
}

/**
 * Claude Code options that switch its permission checks off. Agent control
 * must never be a way around the permission mode the user chose: an agent
 * that already runs without prompts could otherwise launch another one
 * that also doesn't ask. Matched anywhere in the command line, so a wrapper
 * (`env X=1 claude ...`) is caught too. A guardrail, not a sandbox: a
 * script the agent writes first isn't inspected.
 */
const BYPASS_PATTERNS: RegExp[] = [
  /--dangerously-skip-permissions\b/,
  /--allow-dangerously-skip-permissions\b/,
  /--permission-mode(=|\s+)["']?bypassPermissions\b/,
];

export function bypassFlagIn(command: string): string | null {
  for (const pattern of BYPASS_PATTERNS) {
    const match = command.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/** At most `limit` actions per caller in any `windowMs`. In memory: a
 *  restart resets it, as it does every terminal's token. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  /** Records an action unless the caller is over the limit. */
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  forget(key: string): void {
    this.hits.delete(key);
  }
}

/** A session's state in the agent API's words, which match Herdr's:
 *  `blocked` waits on the user, `done` finished and hasn't been looked at,
 *  `idle` is ready, `ended` has no Claude running any more, and `none`
 *  never had one (a plain shell). */
export type PublicStatus = "working" | "blocked" | "done" | "idle" | "ended" | "none";

export const WAITABLE_STATUSES: PublicStatus[] = ["working", "blocked", "done", "idle", "ended"];

export function publicStatus(session: AgentSession | undefined): PublicStatus {
  if (!session) return "none";
  if (!session.running) return "ended";
  switch (session.status) {
    case "working":
      return "working";
    case "needs-attention":
      return session.needs === "unread-turn" ? "done" : "blocked";
    case "finished-unread":
      return "done";
    default:
      return "idle";
  }
}

/** The last `count` lines of a terminal's text, with trailing blank lines
 *  (the empty rows below the cursor) dropped first. */
export function tailLines(lines: string[], count: number): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(Math.max(0, end - count), end);
}

/** The first line matching `pattern`: a substring, or a regular expression
 *  when `regex` is set. Throws ApiError for an invalid expression. */
export function findMatchingLine(lines: string[], pattern: string, regex: boolean): string | null {
  let test: (line: string) => boolean;
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      throw new ApiError("invalid_params", `Not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }
    test = (line) => re.test(line);
  } else {
    test = (line) => line.includes(pattern);
  }
  return lines.find(test) ?? null;
}

// ---- Parameter readers. Every method's params arrive as untyped JSON. ----

export type Params = Record<string, unknown>;

export function asParams(value: unknown): Params {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Params) : {};
}

export function requireString(params: Params, key: string, maxLength = 20000): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") throw new ApiError("invalid_params", `"${key}" is required`);
  if (value.length > maxLength) throw new ApiError("invalid_params", `"${key}" is longer than ${maxLength} characters`);
  return value;
}

export function optionalString(params: Params, key: string, maxLength = 20000): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ApiError("invalid_params", `"${key}" must be a string`);
  if (value.length > maxLength) throw new ApiError("invalid_params", `"${key}" is longer than ${maxLength} characters`);
  return value;
}

export function optionalInt(params: Params, key: string, fallback: number, min: number, max: number): number {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError("invalid_params", `"${key}" must be a number`);
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function optionalBool(params: Params, key: string): boolean {
  return params[key] === true;
}

export function optionalChoice<T extends string>(params: Params, key: string, choices: readonly T[], fallback: T): T {
  const value = params[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) return value as T;
  throw new ApiError("invalid_params", `"${key}" must be one of: ${choices.join(", ")}`);
}
