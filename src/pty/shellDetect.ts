import { fileExistsSync } from "../node/fs";
import { execFileText, getEnvVar } from "../node/process";

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
    const { stdout } = await execFileText(loginShell, ["-lic", `which ${bin}`], { timeout: 5000 });
    const resolved = stdout.trim().split("\n").pop()?.trim();
    return resolved && fileExistsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
