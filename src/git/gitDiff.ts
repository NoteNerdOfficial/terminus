import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

/**
 * Returns the file's content as of the vault's last git commit, or null if
 * it's unavailable for any reason (vault isn't a git repo, git isn't
 * installed, file isn't tracked, no commits yet, file is outside the
 * vault). This is purely an additional, informational baseline for review
 * -- unlike diff.oldText/revertText, it has no bearing on accept/reject.
 */
export async function getGitHeadContent(vaultBasePath: string, absoluteFilePath: string): Promise<string | null> {
  const relPath = path.relative(vaultBasePath, absoluteFilePath);
  if (relPath.startsWith("..")) return null;

  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${relPath}`], {
      cwd: vaultBasePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}
