/**
 * Claude Code runs a hook's `command` through the shell, so a bridge script
 * whose path has a space in it (a vault called "My Notes") has to be quoted
 * or the shell runs the first word and fails ("/Users/me/My: No such file").
 * A path made only of safe characters is left exactly as it was, so the
 * entries already written for such vaults still match and nothing churns.
 */
const SAFE_PATH = /^[A-Za-z0-9_/.:@%+=,-]+$/;

export function hookCommand(path: string): string {
  return SAFE_PATH.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

interface HookEntry {
  hooks?: Array<{ command?: string }>;
}

/**
 * Rewrites hook entries that hold one of our bridge paths unquoted (written
 * before this, and failing for a path with a space) to their quoted form, in
 * place. Returns whether any changed.
 */
export function quoteLegacyCommands(hooks: Record<string, HookEntry[] | undefined>, paths: string[]): boolean {
  let changed = false;
  for (const entries of Object.values(hooks)) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        const path = paths.find((p) => p === hook.command);
        if (path && hookCommand(path) !== path) {
          hook.command = hookCommand(path);
          changed = true;
        }
      }
    }
  }
  return changed;
}
