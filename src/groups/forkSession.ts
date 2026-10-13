/**
 * Forking a Claude session into a new terminal: `claude --resume <id>
 * --fork-session` starts a new session that continues from the old one's
 * conversation, leaving the original alone. t3code's "fork to explore".
 *
 * The id comes from a hook payload and ends up typed into a shell, so it is
 * only used when it looks like what Claude Code issues (a UUID); anything
 * else yields no command rather than a shell-quoting problem.
 */
const SESSION_ID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

export function forkCommand(sessionId: string | null): string | null {
  return sessionId && SESSION_ID.test(sessionId) ? `claude --resume ${sessionId} --fork-session` : null;
}
