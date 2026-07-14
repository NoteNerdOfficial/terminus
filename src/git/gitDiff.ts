import { pathRelative } from "../node/fs";
import { execFileText } from "../node/process";

/**
 * Returns the file's content as of the vault's last git commit, or null if
 * it's unavailable for any reason (vault isn't a git repo, git isn't
 * installed, file isn't tracked, no commits yet, file is outside the
 * vault). This is purely an additional, informational baseline for review
 * -- unlike diff.oldText/revertText, it has no bearing on accept/reject.
 */
export async function getGitHeadContent(vaultBasePath: string, absoluteFilePath: string): Promise<string | null> {
  const relPath = pathRelative(vaultBasePath, absoluteFilePath);
  if (relPath.startsWith("..")) return null;

  try {
    const { stdout } = await execFileText("git", ["show", `HEAD:${relPath}`], {
      cwd: vaultBasePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}
