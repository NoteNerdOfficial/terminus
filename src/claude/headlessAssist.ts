import { fileExistsSync, execFileText, getEnvVar, pathJoin, type ExecFileError } from "terminus-node-bridge";
import { tryLoginShellWhich, resolveSpawnEnv } from "../pty/shellDetect";
import { errorMessage } from "../util/errors";

const TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 20_000;

/** Every non-interactive `claude` invocation needs these two flags, not
 *  just `--allowedTools ""`: with no `--mcp-config` given, `claude -p`
 *  otherwise tries to connect every MCP server configured in the user's
 *  *global* Claude Code settings (Figma, Slack, Jira, GitHub, etc.) before
 *  it will answer at all -- confirmed (in a sibling plugin hitting the
 *  identical problem) to hang for the full timeout if even one of those
 *  needs interactive OAuth, which a spawned background process can never
 *  complete. `--strict-mcp-config` with no `--mcp-config` means "use zero
 *  MCP servers"; `--permission-mode dontAsk` stops it blocking on a tool-
 *  approval prompt instead. Deliberately not `--bare`, which looks like the
 *  same fix but also disables OAuth-token login entirely. */
const NON_INTERACTIVE_ARGS = ["--strict-mcp-config", "--permission-mode", "dontAsk"];

/** Every headless call here runs with `--allowedTools ""` (no file/bash
 *  access), so unlike an interactive `claude` session, its own working
 *  directory can never actually matter to the answer -- but claude's own
 *  startup routine still walks upward from it looking for CLAUDE.md/git
 *  context, and on some machines that walk into a TCC-protected folder
 *  (e.g. a vault under `~/Documents`) triggers a fresh macOS permission
 *  dialog that a spawned background process can never answer, hanging it
 *  indefinitely (the exact same failure shape as the Keychain/MCP hangs
 *  above, one layer further in). Pinning to the OS temp dir sidesteps the
 *  whole class of problem regardless of where the vault happens to live,
 *  with zero downside given tools are already off. `TMPDIR` is how macOS
 *  and Linux both expose it via env (no Node `os.tmpdir()` available
 *  through terminus-node-bridge); `/tmp` covers the rare case it's unset. */
function resolveHeadlessCwd(): string {
  return getEnvVar("TMPDIR") || "/tmp";
}

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

/** Only worth suggesting when no token is already in play -- if one's
 *  already configured, repeating the same advice would just be noise.
 *  `confident` swaps the hedged "if this keeps happening" phrasing for a
 *  direct instruction, for failures claude itself reports unambiguously
 *  (an auth error) rather than an unexplained hang that could be anything. */
function settingsHint(authToken: string | undefined, confident: boolean): string {
  if (authToken) return "";
  if (confident) {
    return ' Add a Claude Code auth token in Terminus settings under Advanced. Run "claude setup-token" in a real terminal and paste the result there.';
  }
  return ' If this keeps happening, try adding a Claude Code auth token in Terminus settings under Advanced. Run "claude setup-token" in a real terminal and paste the result there.';
}

/** Shared low-level spawn, independent of any interactive terminal session
 *  -- so it works even when the terminal where a failure happened never
 *  ran `claude` at all. Throws a message that's already diagnostic (never
 *  Node's own "Command failed: <cmd> <args...>", which is useless here
 *  since one of the args is a multi-KB prompt) but with no settings hint
 *  attached -- callers that want one add it themselves, since a hint makes
 *  sense on a real failed query but not on the settings tab's own Test
 *  button, which already has all the context it needs. */
async function spawnClaude(claudeBin: string, args: string[], authToken: string | undefined, timeoutMs: number): Promise<string> {
  // Obsidian's Electron process doesn't inherit the login shell's env
  // (proxy vars a corporate network may require, etc.) -- without this,
  // claude can silently hang trying to reach the API directly instead of
  // failing fast, indistinguishable from a slow query until the timeout.
  const env = await resolveSpawnEnv();
  // On some machines, Claude Code's normal Keychain-based login can't be
  // read by this freshly-spawned process at all (a differently-signed
  // binary asking for another app's Keychain item can trigger an
  // off-screen consent dialog that never resolves) -- an explicit token
  // from `claude setup-token`, opted into via settings, bypasses that read
  // entirely. Left untouched when no token is configured, so default
  // behavior is exactly the existing Keychain-based login.
  if (authToken) env.CLAUDE_CODE_OAUTH_TOKEN = authToken;
  try {
    const { stdout } = await execFileText(claudeBin, args, {
      cwd: resolveHeadlessCwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    return stdout;
  } catch (err) {
    const execErr = err as ExecFileError;
    if (execErr.killed || execErr.signal) {
      throw new Error(`claude timed out after ${timeoutMs / 1000}s with no response`);
    }
    const stderr = execErr.stderr?.trim();
    throw new Error(`claude exited with code ${execErr.code ?? "unknown"}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
  }
}

/** `--allowedTools ""` (verified empirically) keeps this a pure Q&A turn:
 *  no file/bash access, since this should never be able to take action on
 *  its own. */
async function runHeadlessQuery(claudeBin: string, prompt: string, authToken?: string): Promise<string> {
  let stdout: string;
  try {
    stdout = await spawnClaude(
      claudeBin,
      ["-p", prompt, "--allowedTools", "", "--output-format", "json", ...NON_INTERACTIVE_ARGS],
      authToken,
      TIMEOUT_MS
    );
  } catch (err) {
    const message = errorMessage(err);
    // "not logged in" (or similar) is an explicit, unambiguous signal
    // straight from claude itself -- worth a confident pointer at the fix
    // instead of the generic hedge a bare timeout gets, since a hang can't
    // be distinguished from a genuinely slow query until the timeout fires.
    const isAuthFailure = /not logged in|please run.*login|authentication/i.test(message);
    throw new Error(`${message}${settingsHint(authToken, isAuthFailure)}`);
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

/** Backs the "Test" button next to the auth token field in settings.
 *  Deliberately bypasses `runHeadlessQuery` (no JSON parsing, no settings
 *  hint on failure -- the settings tab already has all the context a hint
 *  would add) and uses a shorter timeout than a real query, since this is
 *  a synchronous check the user is actively sitting and waiting on, not a
 *  background command-help lookup. Settings changes apply immediately
 *  (this function, like `explainCommandOutput`/`suggestFixCommand`, always
 *  reads whatever token was just passed in -- nothing here is cached), so
 *  a successful test means the feature is ready to use right away, no
 *  restart needed. Throws on failure; the caller renders `errorMessage`. */
export async function testClaudeConnection(claudeBin: string, authToken?: string): Promise<void> {
  await spawnClaude(
    claudeBin,
    ["-p", "Reply with exactly: OK", "--allowedTools", "", "--output-format", "json", ...NON_INTERACTIVE_ARGS],
    authToken,
    TEST_TIMEOUT_MS
  );
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
export async function explainCommandOutput(claudeBin: string, transcript: string, authToken?: string): Promise<string> {
  const prompt = `Here is a raw terminal transcript: the most recent command that failed, plus a few commands run right before it for context (there may be just the one, or several). Explain in plain English, for someone new to the terminal, what happened with the LAST command and what they should consider doing next -- factoring in the earlier commands if they're relevant (e.g. a step that was skipped). Do not run any commands or use any tools, just answer in plain text (2-4 sentences max).

${transcript}`;
  return runHeadlessQuery(claudeBin, prompt, authToken);
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
  transcript: string,
  excludeCommands: string[] = [],
  authToken?: string
): Promise<FixSuggestionResult> {
  const exclusion =
    excludeCommands.length > 0
      ? `\nThe user already saw and rejected ${excludeCommands.length === 1 ? "this previous suggestion" : "these previous suggestions"} as not helpful -- suggest a genuinely different option: ${excludeCommands.join(", ")}\n`
      : "";

  const prompt = `Here is a raw terminal transcript: the most recent command that failed, plus a few commands run right before it for context (there may be just the one, or several -- e.g. a failed \`git push\` after \`git init\`/\`git add\`/\`git commit\` might really need one of the earlier steps fixed, not push itself). The failing command might be a typo of a real command, or plain-English text the shell rejected because it isn't a command at all. Suggest the ONE best shell command to fix or address the problem with the LAST command, with a short one-sentence rationale, using the earlier commands as context where relevant. Respond with ONLY a raw JSON object, no markdown fences, no explanation outside the JSON: {"command": "...", "description": "..."}. If nothing safe/confident comes to mind, respond with exactly: null. Never suggest a command whose only purpose is to explain a refusal (e.g. an echo statement) -- in that case also just respond with null.
${exclusion}
${transcript}`;

  const raw = (await runHeadlessQuery(claudeBin, prompt, authToken)).trim();
  if (/^null\.?$/i.test(raw)) return { type: "none" };

  const suggestion = parseSuggestion(raw);
  if (suggestion) return { type: "suggestion", ...suggestion };

  return { type: "unstructured", text: raw };
}
