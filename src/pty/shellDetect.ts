import { fileExistsSync, execFileText, getEnvVar, getAllEnvVars } from "terminus-node-bridge";
import { withoutInheritedClaudeSession } from "./claudeSessionEnv";

/** Login-shell startup runs the user's whole rc chain, which can take
 *  several seconds on machines with heavy shell setup. A probe that gives up
 *  early silently loses the env it was meant to capture, so this is generous. */
const LOGIN_SHELL_TIMEOUT_MS = 20_000;

const PYTHON3_CANDIDATES = [
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
];

/**
 * Electron apps launched from Finder/Dock often inherit a minimal PATH
 * (e.g. just /usr/bin:/bin:/usr/sbin:/sbin), not the user's shell-rc PATH,
 * so `python3` on process.env.PATH may not resolve even though it works in
 * a real terminal. Resolve via a login-shell `which` first (matches the
 * user's actual PATH), then fall back to common absolute locations.
 */
export async function resolvePython3(): Promise<string> {
  const loginShellPath = await tryLoginShellWhich("python3");
  if (loginShellPath) return loginShellPath;

  for (const candidate of PYTHON3_CANDIDATES) {
    if (fileExistsSync(candidate)) return candidate;
  }

  return "python3"; // last resort: let spawn() try PATH resolution itself
}

export function resolveUserShell(): string {
  return getEnvVar("SHELL") || "/bin/zsh";
}

export async function tryLoginShellWhich(bin: string): Promise<string | null> {
  const loginShell = resolveUserShell();
  try {
    const { stdout } = await execFileText(loginShell, ["-lic", `which ${bin}`], { timeout: LOGIN_SHELL_TIMEOUT_MS });
    // Login-shell startup/logout hooks (MOTD, session-save
    // scripts, etc.) can print extra lines before or after `which`'s own
    // output, so the resolved path isn't reliably the last line -- scan
    // every line for one that actually names and contains this binary.
    const lines = stdout.split("\n").map((line) => line.trim());
    const resolved = lines.find((line) => line.endsWith(`/${bin}`) && fileExistsSync(line));
    return resolved ?? null;
  } catch {
    return null;
  }
}

let cachedLoginShellEnv: Promise<Record<string, string> | null> | null = null;

/** Proxy and certificate settings (HTTPS_PROXY, NODE_EXTRA_CA_CERTS, etc.)
 *  are usually set by the login shell's own rc files -- Obsidian's Electron
 *  process doesn't inherit those (same root problem as the PATH lookup
 *  above), so a spawned `claude` can silently hang trying to reach
 *  Anthropic's API without them, rather than failing fast. Resolve the login
 *  shell's real env and merge it into the child's env at spawn time.
 *
 *  Only a successful probe is cached (spawning a login shell has real
 *  startup cost, and the result only reflects the machine's config). A
 *  failed or timed-out probe resolves to `null` and is retried on the next
 *  call, so one slow startup can't leave every later query without the env
 *  for the rest of the session. */
export function resolveLoginShellEnv(): Promise<Record<string, string> | null> {
  if (cachedLoginShellEnv) return cachedLoginShellEnv;
  const probe = (async () => {
    const loginShell = resolveUserShell();
    try {
      const { stdout } = await execFileText(loginShell, ["-lic", "env -0"], {
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      const env: Record<string, string> = {};
      for (const entry of stdout.split("\0")) {
        const idx = entry.indexOf("=");
        if (idx <= 0) continue;
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
      return env;
    } catch {
      return null;
    }
  })();
  cachedLoginShellEnv = probe;
  void probe.then((env) => {
    if (env === null && cachedLoginShellEnv === probe) cachedLoginShellEnv = null;
  });
  return probe;
}

export interface SpawnEnv {
  env: Record<string, string | undefined>;
  /** False when the login shell's env couldn't be read, so `env` is only
   *  Obsidian's own (possibly minimal) environment. */
  loginShellEnvLoaded: boolean;
}

export async function resolveSpawnEnv(): Promise<SpawnEnv> {
  const loginShellEnv = await resolveLoginShellEnv();
  // The login shell was started from Obsidian's environment, so it echoes
  // back any inherited Claude session variables too: strip after merging.
  return {
    env: withoutInheritedClaudeSession({ ...getAllEnvVars(), ...loginShellEnv }),
    loginShellEnvLoaded: loginShellEnv !== null,
  };
}
