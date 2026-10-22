import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { PendingChangesStore, type RecordChangeInput } from "../src/state/PendingChangesStore";
import type { BashToolHookPayload } from "../src/hooks/types";
import type { DiffResult } from "../src/server/diff";

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

function record(store: PendingChangesStore, diff: Partial<DiffResult> & { oldText: string; newText: string }): void {
  const input: RecordChangeInput = {
    payload,
    diff: {
      filePath: FILE,
      existedBefore: diff.oldText !== "",
      revertText: diff.oldText,
      ...diff,
    },
    token: "tok",
    panelLabel: "Terminus 1",
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
