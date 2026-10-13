/**
 * Variables a running Claude Code session sets for the processes it starts,
 * seen in Claude Code 2.1.296. Obsidian opened from such a session (say
 * `open -a Obsidian` in Claude's shell) inherits them, and every terminal
 * would pass them on. A `claude` started there then believes it's a child
 * of that session: CLAUDE_CODE_CHILD_SESSION turns transcript saving off
 * (no /resume, no usage in the Agent inbox), and the messaging socket
 * points back at the other session.
 *
 * Only these are removed. CLAUDE_CODE_* settings people set on purpose
 * (CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_MAX_OUTPUT_TOKENS, ...) are kept.
 */
const SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

/** Present only when the environment came from inside a Claude session. */
const SESSION_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"];

/**
 * `env` without another Claude Code session's variables, when it carries
 * them. Without a session marker it's returned as is, so a variable such as
 * CLAUDE_EFFORT that someone exports themselves is left alone.
 */
export function withoutInheritedClaudeSession<T extends Record<string, string | undefined>>(env: T): T {
  if (!SESSION_MARKERS.some((name) => env[name] !== undefined)) return env;
  const cleaned: Record<string, string | undefined> = { ...env };
  for (const name of SESSION_VARIABLES) delete cleaned[name];
  return cleaned as T;
}
