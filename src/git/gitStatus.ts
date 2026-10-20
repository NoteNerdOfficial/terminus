import { execFileText, pathJoin } from "terminus-node-bridge";

/**
 * Snapshots of `git status` for a session's folder, used to notice files
 * Claude changed through the shell rather than through Edit/Write/
 * NotebookEdit -- `sed -i`, a formatter, a package manager rewriting a
 * lockfile, `git mv`. Our PreToolUse matcher is exactly those three tools
 * (see hooks/provisionSettings.ts) and Bash results carry no diff of their
 * own, so without this the review panel is silently empty for that whole
 * class of edit -- the one failure mode a review tool can't afford, since
 * an empty panel reads as "nothing happened".
 *
 * Read at a turn's start and again at its end (see TerminalView), then
 * compared: a file whose status changed during the turn with no pending
 * change to account for it is one of these. Taking the baseline per turn
 * rather than per session is what keeps the user's own edits out -- those
 * happen between turns, whereas during one Claude is the only writer.
 *
 * Deliberately only ever reports a count and a list of paths. Crediting a
 * shell edit to a particular turn's commands, or rebuilding its diff, is
 * guesswork that gets it wrong whenever a file is touched twice or someone
 * else commits mid-session; naming the file and letting the user look is
 * both honest and enough. Nothing here polls, and nothing runs outside a
 * repo.
 */

/** One entry of `git status --porcelain`: git's two status letters and the
 *  absolute path, resolved against the repo root. */
export interface GitStatusEntry {
  filePath: string;
  /** Git's XY pair, verbatim: "M ", " M", "??", "A ", "R ". */
  status: string;
}

export interface GitStatus {
  root: string;
  /** Absolute path -> status letters. */
  entries: Map<string, string>;
}

/** Null when `cwd` isn't in a repo, git is missing, or the call fails for
 *  any other reason: this is an informational extra, never a blocker. */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    // --show-cdup (the relative way up to the repo root) rather than
    // --show-toplevel (the absolute path to it): toplevel is resolved
    // through symlinks, so on a vault reached by one it would spell every
    // path differently from the hook payloads these get compared against,
    // and every tool edit would look like a shell edit. Joining cdup onto
    // the caller's own cwd keeps one spelling throughout. Empty output
    // means cwd already IS the root.
    const { stdout: cdup } = await execFileText("git", ["rev-parse", "--show-cdup"], { cwd, maxBuffer: 64 * 1024 });
    const root = pathJoin(cwd, cdup.trim());
    // -z: NUL-separated and unquoted, so paths with spaces, quotes or
    // non-ASCII arrive verbatim instead of in git's quoted form. -uall
    // names each untracked file rather than just its directory, so a file
    // Claude created with a shell redirect is listed individually. Ignored
    // files are left out by default, which is what keeps node_modules and
    // other build output from ever showing up here.
    const { stdout } = await execFileText("git", ["status", "--porcelain", "-z", "-uall"], { cwd, maxBuffer: 4 * 1024 * 1024 });
    return { root, entries: parsePorcelainZ(stdout, root) };
  } catch {
    return null;
  }
}

/**
 * Paths whose status appeared or changed between two snapshots. A file
 * already dirty before the turn that still carries the same status is left
 * out, so work in progress from before Claude started isn't reported as its
 * doing. With no baseline (the turn began before Terminus saw the session,
 * or the folder wasn't a repo then) nothing is reported at all rather than
 * every dirty file at once.
 */
export function changedSince(before: GitStatus | null, after: GitStatus | null): GitStatusEntry[] {
  if (!before || !after) return [];
  const changed: GitStatusEntry[] = [];
  for (const [filePath, status] of after.entries) {
    if (before.entries.get(filePath) === status) continue;
    changed.push({ filePath, status });
  }
  return changed;
}

/** Git's status letters as one word for the card. */
export function describeStatus(status: string): string {
  if (status.includes("?")) return "new";
  if (status.includes("D")) return "deleted";
  if (status.includes("R")) return "renamed";
  if (status.includes("A")) return "added";
  return "modified";
}

function parsePorcelainZ(stdout: string, root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    // The trailing empty field after the last NUL, and any blank entry.
    if (!field) continue;
    // "XY path": two status letters, a space, then the path.
    const status = field.slice(0, 2);
    const path = field.slice(3);
    if (!path) continue;
    entries.set(pathJoin(root, path), status);
    // A rename or copy is followed by its source path in a field of its
    // own, which has to be consumed rather than read as the next entry.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return entries;
}
