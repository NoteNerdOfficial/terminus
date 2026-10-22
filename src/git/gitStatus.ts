import { execFileText, pathJoin, pathRelative } from "terminus-node-bridge";

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
 * A file that was CLEAN when the turn began has an exact before-state: its
 * content at HEAD (see readGitFileAtHead). Those become ordinary reviewable
 * changes, with a diff and a Reject that restores real bytes. For a file
 * that was already dirty, HEAD is not what it looked like before Claude
 * touched it, and no exact revert exists -- so those keep the old treatment
 * of a name and a status word, which is honest about what is known.
 *
 * Nothing here polls, and nothing runs outside a repo.
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

/**
 * A tracked file's content at HEAD, or null when HEAD has no such path or
 * the read fails for any reason.
 *
 * This is the pre-turn snapshot for a shell edit that nothing else took one
 * of. It is only equivalent to "the content before this turn" for a file
 * that was CLEAN when the turn began -- then HEAD and the pre-turn bytes are
 * the same, which is what makes a Reject on one of these exact rather than a
 * guess. A file already dirty at the baseline has no such equivalence, so
 * callers must not use this for one (see TerminalView.changeFromShellEntry).
 *
 * The one case it still gets wrong is a commit made mid-turn, which moves
 * HEAD out from under the comparison. Rare enough, and visible in the diff
 * itself, to be worth the exactness everywhere else.
 */
const MAX_BASELINE_CHARS = 2 * 1024 * 1024;

export async function readGitFileAtHead(root: string, filePath: string): Promise<string | null> {
  // git wants a repo-root-relative path with forward slashes, whatever the
  // platform spells them as.
  const relative = pathRelative(root, filePath).split("\\").join("/");
  if (!relative || relative.startsWith("..")) return null;
  try {
    const { stdout } = await execFileText("git", ["show", `HEAD:${relative}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    // A NUL byte means this was never text: a diff of it would be nonsense
    // and a UTF-8 revert would corrupt it, so it is left to the read-only
    // list rather than turned into a reviewable change. The size cap is
    // there for the same reason -- past it the diff is unreadable and the
    // content is not worth holding twice (see TerminalView's own).
    if (stdout.includes("\u0000") || stdout.length > MAX_BASELINE_CHARS) return null;
    return stdout;
  } catch {
    return null;
  }
}

/** Whether git's status letters say the file is new -- "??" untracked, or
 *  "A" already added to the index. Both mean HEAD has no copy, so the
 *  pre-turn content is "didn't exist" and a Reject deletes it. */
export function isNewFile(status: string): boolean {
  return status.includes("?") || status.includes("A");
}

/** A rename or copy, whose before/after pairing we don't reconstruct. */
export function isRenameOrCopy(status: string): boolean {
  return status.includes("R") || status.includes("C");
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
