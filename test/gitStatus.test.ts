import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitStatus, changedSince, describeStatus } from "../src/git/gitStatus";

/**
 * Shell-edit detection, against a real git repository rather than canned
 * output -- the parsing has to survive what git actually prints, and the
 * cases that break a naive reader (a path with a space, a rename's trailing
 * source field) only show up that way.
 */

let repo = "";
let plain = "";
let before_: Awaited<ReturnType<typeof readGitStatus>> = null;
let after_: Awaited<ReturnType<typeof readGitStatus>> = null;
let changedPaths: string[] = [];

before(async () => {
  repo = mkdtempSync(join(tmpdir(), "terminus-git-"));
  plain = mkdtempSync(join(tmpdir(), "terminus-plain-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.ts"), "a\n");
  writeFileSync(join(repo, "src/with space.ts"), "s\n");
  writeFileSync(join(repo, "to-rename.ts"), "r\n");
  writeFileSync(join(repo, "to-delete.ts"), "d\n");
  writeFileSync(join(repo, "dirty-before.ts"), "x\n");
  writeFileSync(join(repo, ".gitignore"), "ignored/\n");
  mkdirSync(join(repo, "ignored"));
  git("add", "-A");
  git("commit", "-qm", "baseline");

  // Work in progress from before the turn started.
  writeFileSync(join(repo, "dirty-before.ts"), "the user's own edit\n");
  before_ = await readGitStatus(repo);

  // Now "Claude" works through the shell.
  writeFileSync(join(repo, "src/a.ts"), "a changed\n");
  writeFileSync(join(repo, "src/with space.ts"), "s changed\n");
  writeFileSync(join(repo, "new-untracked.ts"), "n\n");
  writeFileSync(join(repo, "ignored/junk.log"), "noise\n");
  git("mv", "to-rename.ts", "renamed.ts");
  git("rm", "-q", "to-delete.ts");

  after_ = await readGitStatus(repo);
  changedPaths = changedSince(before_, after_).map((entry) => entry.filePath.slice(repo.length + 1));
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

describe("git status snapshots", () => {
  it("keys paths off the caller's own cwd spelling, not git's resolved one", () => {
    // --show-toplevel resolves symlinks; on a vault reached through one that
    // would spell every path differently from the hook payloads these get
    // compared against, making every tool edit look like a shell edit.
    assert.equal(before_!.root, repo);
    assert.ok(before_!.entries.has(join(repo, "dirty-before.ts")), "the pre-existing edit is in the baseline");
  });

  it("parses a path containing a space", () => {
    assert.ok(changedPaths.includes("src/with space.ts"));
  });

  it("lists untracked files but never ignored ones", () => {
    assert.ok(changedPaths.includes("new-untracked.ts"));
    assert.ok(!changedPaths.some((path) => path.startsWith("ignored/")));
  });

  it("consumes a rename's trailing source field instead of reading it as an entry", () => {
    assert.ok(changedPaths.includes("renamed.ts"));
    assert.ok(!changedPaths.includes("to-rename.ts"), "the source path is not a separate entry");
    const renamed = changedSince(before_, after_).find((entry) => entry.filePath.endsWith("renamed.ts"))!;
    assert.equal(describeStatus(renamed.status), "renamed");
  });

  it("reports deletions", () => {
    assert.ok(changedPaths.includes("to-delete.ts"));
    const deleted = changedSince(before_, after_).find((entry) => entry.filePath.endsWith("to-delete.ts"))!;
    assert.equal(describeStatus(deleted.status), "deleted");
  });

  it("excludes work that was already dirty before the turn", () => {
    assert.ok(!changedPaths.includes("dirty-before.ts"), "the user's own edit is not reported as Claude's");
  });

  it("reports nothing at all without a baseline", () => {
    assert.deepEqual(changedSince(null, after_), [], "better to miss than to blame everything dirty");
  });

  it("returns null outside a repository", async () => {
    assert.equal(await readGitStatus(plain), null);
  });
});
