import { execFileText } from "terminus-node-bridge";

/**
 * The checked-out branch of the repo containing `cwd`, or null when it isn't
 * a repo, git is missing, or HEAD is detached. Read on demand only (the
 * Agent inbox asks at SessionStart and on Stop); nothing polls it.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileText("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, maxBuffer: 64 * 1024 });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}
