import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { PendingChangesStore, type RecordChangeInput } from "../src/state/PendingChangesStore";
import type { BashToolHookPayload } from "../src/hooks/types";
import type { DiffResult } from "../src/server/diff";
import { confirmCollisionHunkAccept, diffBaselines, otherContributorsLabel } from "../src/modals/collisions";
import { owningContributor } from "../src/state/PendingChangesStore";
import type { App } from "obsidian";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Coalescing within one review window. Several edits to one file collapse
 * into a single row measured against what the file was before any of them,
 * which is also what decides when there is nothing left to review at all.
 */

const FILE = "/vault/note.md";

const payload: BashToolHookPayload = {
  session_id: "s",
  transcript_path: "/t",
  cwd: "/vault",
  prompt_id: "turn-1",
  permission_mode: "",
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: "",
  tool_input: { command: "" },
};

function record(
  store: PendingChangesStore,
  diff: Partial<DiffResult> & { oldText: string; newText: string },
  who?: { token: string; label: string }
): void {
  const input: RecordChangeInput = {
    payload,
    diff: {
      filePath: FILE,
      existedBefore: diff.oldText !== "",
      revertText: diff.oldText,
      ...diff,
    },
    token: who?.token ?? "tok",
    panelLabel: who?.label ?? "Terminus 1",
    panelColor: null,
    promptId: "turn-1",
  };
  store.recordChange(input);
}

let store: PendingChangesStore;
beforeEach(() => {
  store = new PendingChangesStore();
});

describe("pending changes: a row that still has something to review", () => {
  it("keeps a plain create", () => {
    record(store, { oldText: "", newText: "# hi\n", existedBefore: false, revertText: "" });
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]!.diff.newText, "# hi\n");
  });

  it("coalesces a create and a later edit, keeping the create's baseline", () => {
    record(store, { oldText: "", newText: "# hi\n", existedBefore: false, revertText: "" });
    record(store, { oldText: "# hi\n", newText: "# hi\nmore\n" });

    const [change] = store.list();
    assert.equal(store.list().length, 1);
    assert.equal(change!.editCount, 2);
    // The baseline is "didn't exist", so a reject deletes rather than
    // leaving the file behind with the first edit's content.
    assert.equal(change!.diff.existedBefore, false);
    assert.equal(change!.diff.oldText, "");
    assert.equal(change!.diff.newText, "# hi\nmore\n");
  });
});

describe("pending changes: a row with nothing left to review", () => {
  it("drops a file created and then deleted in the same window", () => {
    record(store, { oldText: "", newText: "# hi\n", existedBefore: false, revertText: "" });
    assert.equal(store.list().length, 1, "the create is reviewable on its own");

    // The delete's own diff is content -> gone; coalesced against the
    // create's baseline that is "" -> "", which is no change at all.
    record(store, { oldText: "# hi\n", newText: "", existedBefore: true });
    assert.deepEqual(store.list(), [], "nothing to accept or reject, so no row");
  });

  it("drops a file edited and then changed back to what it was", () => {
    record(store, { oldText: "original\n", newText: "changed\n" });
    assert.equal(store.list().length, 1);

    record(store, { oldText: "changed\n", newText: "original\n" });
    assert.deepEqual(store.list(), []);
  });

  it("never opens a row for an edit that changed nothing", () => {
    record(store, { oldText: "same\n", newText: "same\n" });
    assert.deepEqual(store.list(), []);
  });

  it("clears an inline editor overlay when it drops the row", () => {
    let clearedAs: boolean | null = null;
    record(store, { oldText: "", newText: "# hi\n", existedBefore: false, revertText: "" });
    store.registerInlineOverlay(FILE, (accepted) => {
      clearedAs = accepted;
    });

    record(store, { oldText: "# hi\n", newText: "", existedBefore: true });
    assert.equal(clearedAs, true, "the file's content stands as it is");
  });

  it("leaves history alone -- nothing was decided", () => {
    record(store, { oldText: "", newText: "# hi\n", existedBefore: false, revertText: "" });
    record(store, { oldText: "# hi\n", newText: "", existedBefore: true });
    assert.deepEqual(store.listHistory(), []);
  });
});

/**
 * The snapshot that makes the second baseline possible. recordChange resets
 * a coalesced row's oldText to the FIRST edit's state, so the version a
 * later terminal overwrote would otherwise exist nowhere. It is kept on
 * that terminal's contributor entry, and Split Diff offers it as an
 * alternative left-hand column.
 */
describe("pending changes: what a second terminal overwrote", () => {
  const first = { token: "tok-a", label: "A" };
  const second = { token: "tok-b", label: "B" };

  it("keeps the file as the second terminal found it", () => {
    record(store, { oldText: "original\n", newText: "A wrote this\n" }, first);
    record(store, { oldText: "A wrote this\n", newText: "B wrote this\n" }, second);
    const change = store.list()[0]!;
    assert.equal(change.diff.oldText, "original\n", "the row still reverts to before A");
    assert.equal(change.diff.newText, "B wrote this\n", "and still shows what is on disk");
    assert.equal(change.contributors[0]!.before, undefined, "the first has no earlier state to keep");
    assert.equal(change.contributors[1]!.before, "A wrote this\n", "A's result survives on B's entry");
  });

  it("offers it as a second baseline, labelled by who overwrote it", () => {
    record(store, { oldText: "original\n", newText: "A wrote this\n" }, first);
    record(store, { oldText: "A wrote this\n", newText: "B wrote this\n" }, second);
    const baselines = diffBaselines(store.list()[0]!);
    assert.equal(baselines.length, 2);
    assert.deepEqual(baselines[0], { label: "Original", text: "original\n" });
    assert.deepEqual(baselines[1], { label: "Before B's edits", text: "A wrote this\n" });
  });

  it("offers only the original when one terminal did all the edits", () => {
    record(store, { oldText: "original\n", newText: "once\n" }, first);
    record(store, { oldText: "once\n", newText: "twice\n" }, first);
    const baselines = diffBaselines(store.list()[0]!);
    assert.equal(baselines.length, 1, "coming back to a file is not a collision");
  });

  it("files the row under the terminal that edited last, and names the other", () => {
    // What Classic's terminal groups and the inbox's cards both file by,
    // so a shared row sits in the same place in either experience; the row
    // itself then names the contributor its group does not.
    record(store, { oldText: "original\n", newText: "A wrote this\n" }, first);
    record(store, { oldText: "A wrote this\n", newText: "B wrote this\n" }, second);
    const change = store.list()[0]!;
    assert.equal(owningContributor(change).token, "tok-b");
    assert.equal(otherContributorsLabel(change), "Also edited by A");
  });

  it("drops a baseline identical to the original", () => {
    // B found the file exactly as it started: A's edit was reverted, or A
    // never touched the bytes B is working from. A second column showing
    // the same text as the first would be noise.
    record(store, { oldText: "original\n", newText: "A wrote this\n" }, first);
    record(store, { oldText: "original\n", newText: "B wrote this\n" }, second);
    const baselines = diffBaselines(store.list()[0]!);
    assert.equal(baselines.length, 1);
  });
});

/**
 * Deciding one hunk at a time on a file two terminals edited. resolveHunk
 * writes the row's baseline with the chosen hunk spliced in, and that
 * baseline predates the FIRST terminal's edit, so a half-finished review
 * leaves the file holding neither terminal's work outside the hunks already
 * decided. confirmCollisionHunkAccept is what says so before the first
 * Accept; these pin the state it warns about.
 */
describe("pending changes: deciding one hunk of a file two terminals edited", () => {
  const first = { token: "tok-a", label: "A" };
  const second = { token: "tok-b", label: "B" };
  const MIDDLE = "keep 1\nkeep 2\nkeep 3\nkeep 4\nkeep 5\n";
  const original = `top\n${MIDDLE}bottom\n`;
  const fromA = `A top\n${MIDDLE}A bottom\n`;
  const fromB = `B top\n${MIDDLE}B bottom\n`;

  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "terminus-hunk-"));
    file = join(dir, "note.md");
  });

  function shared(): void {
    record(store, { filePath: file, oldText: original, newText: fromA }, first);
    record(store, { filePath: file, oldText: fromA, newText: fromB }, second);
  }

  it("leaves the file holding neither terminal's work outside the accepted hunk", async () => {
    shared();
    await store.resolveHunk(file, 0, true);
    assert.equal(
      readFileSync(file, "utf8"),
      `B top\n${MIDDLE}bottom\n`,
      "B's first change is in, and the last line is back to before A"
    );
    assert.equal(store.list().length, 1, "the row stays until the other hunk is decided");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops offering what the second terminal overwrote, which no longer lines up", async () => {
    shared();
    assert.equal(diffBaselines(store.list()[0]!).length, 2, "both baselines before any hunk is decided");
    await store.resolveHunk(file, 0, true);
    const change = store.list()[0]!;
    assert.equal(change.contributors[1]!.before, undefined, "the snapshot went with the baseline it was taken against");
    assert.deepEqual(
      diffBaselines(change).map((b) => b.label),
      ["Original"],
      "only the side that is still in step"
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks nothing when the accept finishes the row or no one else edited it", async () => {
    // The asking path opens a modal, so only its two quiet cases are
    // pinned here; the warning itself is checked in the running app.
    const app = undefined as unknown as App;
    shared();
    assert.equal(await confirmCollisionHunkAccept(app, store.list()[0]!, 1), true, "the last hunk leaves the file whole");

    const alone = new PendingChangesStore();
    record(alone, { filePath: file, oldText: original, newText: fromA }, first);
    assert.equal(await confirmCollisionHunkAccept(app, alone.list()[0]!, 2), true, "one terminal, nothing to lose");
    rmSync(dir, { recursive: true, force: true });
  });
});
