import { fileExistsSync, execFileText, getEnvVar, pathJoin, type ExecFileError } from "terminus-node-bridge";
import { tryLoginShellWhich, resolveSpawnEnv } from "../pty/shellDetect";

const TIMEOUT_MS = 45_000;

// ~/.local/bin/claude is where Claude Code's own official standalone
// installer (the curl | sh method) puts it for a user-level, non-sudo
// install -- confirmed missing here by a real ENOENT report where `which
// claude` in a real terminal resolved to exactly this path.
const CLAUDE_BIN_CANDIDATES = ["/usr/local/bin/claude", "/opt/homebrew/bin/claude"];

function localBinCandidate(): string | null {
  const home = getEnvVar("HOME");
  return home ? pathJoin(home, ".local/bin/claude") : null;
}

/** Same login-shell-`which` + fallback-paths pattern as resolvePython3 in
 *  pty/shellDetect.ts -- Electron apps launched from Finder/Dock often
 *  inherit a minimal PATH that doesn't include where `claude` actually is. */
export async function resolveClaudeBin(): Promise<string> {
  const loginShellPath = await tryLoginShellWhich("claude");
  if (loginShellPath) return loginShellPath;

  const localBin = localBinCandidate();
  const candidates = localBin ? [...CLAUDE_BIN_CANDIDATES, localBin] : CLAUDE_BIN_CANDIDATES;
  for (const candidate of candidates) {
    if (fileExistsSync(candidate)) return candidate;
  }

  return "claude";
}

interface ClaudeJsonResult {
  result?: string;
  is_error?: boolean;
}

function isClaudeJsonResult(value: unknown): value is ClaudeJsonResult {
  return typeof value === "object" && value !== null;
}

/** Fires a single, isolated, tool-free `claude -p` call -- independent of
 *  any interactive terminal session, so it works even when the terminal
 *  where the failure happened never ran `claude` at all. `--allowedTools
 *  ""` (verified empirically) keeps this a pure Q&A turn: no file/bash
 *  access, since this should never be able to take action on its own. */
async function runHeadlessQuery(claudeBin: string, cwd: string, prompt: string): Promise<string> {
  let stdout: string;
  try {
    // Obsidian's Electron process doesn't inherit the login shell's env
    // (proxy vars a corporate network may require, etc.) -- without this,
    // claude can silently hang trying to reach the API directly instead of
    // failing fast, indistinguishable from a slow query until the timeout.
    const env = await resolveSpawnEnv();
    ({ stdout } = await execFileText(
      claudeBin,
      ["-p", prompt, "--allowedTools", "", "--output-format", "json"],
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, env }
    ));
  } catch (err) {
    // execFileText's own rejection .message is Node's "Command failed:
    // <cmd> <args...>" format -- useless here since one of the args is the
    // entire multi-KB prompt, so it surfaces as an unreadable wall of text
    // with no indication of what actually went wrong (confirmed: a killed-
    // by-timeout process produces exactly this shape -- .message with no
    // stderr at all, verified by reproducing a timeout locally). Pull the
    // actually diagnostic fields off the error instead.
    const execErr = err as ExecFileError;
    if (execErr.killed || execErr.signal) {
      throw new Error(`claude timed out after ${TIMEOUT_MS / 1000}s with no response`);
    }
    const stderr = execErr.stderr?.trim();
    throw new Error(`claude exited with code ${execErr.code ?? "unknown"}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }

  let parsed: ClaudeJsonResult;
  try {
    const rawParsed: unknown = JSON.parse(stdout);
    if (!isClaudeJsonResult(rawParsed)) throw new Error("not an object");
    parsed = rawParsed;
  } catch {
    throw new Error("claude returned unparseable output");
  }

  if (parsed.is_error || typeof parsed.result !== "string") {
    throw new Error("claude returned an error result");
  }
  return parsed.result;
}

/** `transcript` is the raw captured terminal text leading up to and
 *  including the failed command -- CommandTracker.getRecentContext()
 *  already includes a few preceding commands too (each with its own
 *  prompt/command/output), not just the failed one alone, since a failure
 *  is sometimes the last step of a short sequence (e.g. a `git push` that
 *  fails because an earlier `git commit` in the same sequence never
 *  happened) where the single failing command's own output doesn't carry
 *  enough context on its own. There's no need to separately parse "the
 *  command" out of it either way; Claude reads a terminal transcript just
 *  fine as-is. */
export async function explainCommandOutput(claudeBin: string, cwd: string, transcript: string): Promise<string> {
  const prompt = `Here is a raw terminal transcript: the most recent command that failed, plus a few commands run right before it for context (there may be just the one, or several). Explain in plain English, for someone new to the terminal, what happened with the LAST command and what they should consider doing next -- factoring in the earlier commands if they're relevant (e.g. a step that was skipped). Do not run any commands or use any tools, just answer in plain text (2-4 sentences max).

${transcript}`;
  return runHeadlessQuery(claudeBin, cwd, prompt);
}

export interface FixSuggestion {
  command: string;
  description: string;
}

/** "suggestion": a clean command to offer via Apply. "none": Claude
 *  confidently found nothing safe to suggest. "unstructured": Claude
 *  responded with something that isn't a suggestion in the requested
 *  shape -- most often because the input wasn't really a shell command at
 *  all (someone typing a plain-English request that the shell rejected)
 *  and Claude answered conversationally instead of picking a single
 *  command. Surfacing that raw text is far more useful than a parse-error
 *  message, since it usually still contains the actual answer, just not
 *  in the {command, description} shape. */
export type FixSuggestionResult =
  | ({ type: "suggestion" } & FixSuggestion)
  | { type: "none" }
  | { type: "unstructured"; text: string };

function isFixSuggestion(value: unknown): value is FixSuggestion {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FixSuggestion).command === "string" &&
    typeof (value as FixSuggestion).description === "string"
  );
}

/** LLM output occasionally deviates from an exact-format instruction even
 *  when the instruction is unambiguous (verified: couldn't reproduce a
 *  parse failure on demand across a range of plain-English and typo'd
 *  inputs, so this is a probabilistic formatting slip, not a systematic
 *  gap for any particular kind of input) -- so parsing tries progressively
 *  looser strategies rather than giving up after the first one fails:
 *  exact JSON, then a {...} object embedded in surrounding prose. */
function parseSuggestion(text: string): FixSuggestion | null {
  try {
    const direct: unknown = JSON.parse(text);
    if (isFixSuggestion(direct)) return direct;
  } catch {
    // fall through to extraction
  }

  const match = text.match(/\{[\s\S]*\}/);
  const matchedText = match?.[0];
  if (matchedText !== undefined) {
    try {
      const embedded: unknown = JSON.parse(matchedText);
      if (isFixSuggestion(embedded)) return embedded;
    } catch {
      // fall through to unstructured
    }
  }

  return null;
}

/** `excludeCommands` lets the "Suggest a fix" action ask for a genuinely
 *  different option on a repeat click, instead of repeating itself --
 *  only suggestions (not "none"/"unstructured" results) get added to that
 *  list by the caller, since those don't have a specific command to avoid
 *  repeating. */
export async function suggestFixCommand(
  claudeBin: string,
  cwd: string,
  transcript: string,
  excludeCommands: string[] = []
): Promise<FixSuggestionResult> {
  const exclusion =
    excludeCommands.length > 0
      ? `\nThe user already saw and rejected ${excludeCommands.length === 1 ? "this previous suggestion" : "these previous suggestions"} as not helpful -- suggest a genuinely different option: ${excludeCommands.join(", ")}\n`
      : "";

  const prompt = `Here is a raw terminal transcript: the most recent command that failed, plus a few commands run right before it for context (there may be just the one, or several -- e.g. a failed \`git push\` after \`git init\`/\`git add\`/\`git commit\` might really need one of the earlier steps fixed, not push itself). The failing command might be a typo of a real command, or plain-English text the shell rejected because it isn't a command at all. Suggest the ONE best shell command to fix or address the problem with the LAST command, with a short one-sentence rationale, using the earlier commands as context where relevant. Respond with ONLY a raw JSON object, no markdown fences, no explanation outside the JSON: {"command": "...", "description": "..."}. If nothing safe/confident comes to mind, respond with exactly: null. Never suggest a command whose only purpose is to explain a refusal (e.g. an echo statement) -- in that case also just respond with null.
${exclusion}
${transcript}`;

  const raw = (await runHeadlessQuery(claudeBin, cwd, prompt)).trim();
  if (/^null\.?$/i.test(raw)) return { type: "none" };

  const suggestion = parseSuggestion(raw);
  if (suggestion) return { type: "suggestion", ...suggestion };

  return { type: "unstructured", text: raw };
}
