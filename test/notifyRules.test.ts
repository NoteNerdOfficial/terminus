import { describe, it } from "node:test";
import assert from "node:assert";
import { attentionTransition, parseOscNotification, previewText, stillCurrent } from "../src/notify/notifyRules";

describe("attention transitions", () => {
  it("announces a permission prompt once, on the way in", () => {
    const working = { status: "working" as const, needs: null };
    const asking = { status: "needs-attention" as const, needs: "permission" as const };
    assert.equal(attentionTransition(working, asking), "needs-input");
    assert.equal(attentionTransition(asking, asking), null);
  });

  it("announces a finished turn once", () => {
    const working = { status: "working" as const, needs: null };
    const done = { status: "finished-unread" as const, needs: null };
    assert.equal(attentionTransition(working, done), "finished");
    assert.equal(attentionTransition(done, done), null);
    assert.equal(attentionTransition(undefined, done), "finished");
  });

  it("stays quiet when idle_prompt re-flags an unread turn", () => {
    const done = { status: "finished-unread" as const, needs: null };
    const reflagged = { status: "needs-attention" as const, needs: "unread-turn" as const };
    assert.equal(attentionTransition(done, reflagged), null);
  });

  it("stays quiet for working and idle", () => {
    assert.equal(attentionTransition(undefined, { status: "working", needs: null }), null);
    assert.equal(attentionTransition({ status: "finished-unread", needs: null }, { status: "idle", needs: null }), null);
  });

  it("drops a pending notification the user has already dealt with", () => {
    assert.equal(stillCurrent("needs-input", { status: "working", needs: null }), false);
    assert.equal(stillCurrent("needs-input", { status: "needs-attention", needs: "input" }), true);
    assert.equal(stillCurrent("finished", { status: "idle", needs: null }), false);
    assert.equal(stillCurrent("finished", { status: "finished-unread", needs: null }), true);
  });
});

describe("OSC notifications", () => {
  it("reads OSC 9's whole payload as the message", () => {
    assert.deepEqual(parseOscNotification(9, "Build finished"), { title: null, body: "Build finished" });
  });

  it("ignores ConEmu's numbered OSC 9 subcommands", () => {
    assert.equal(parseOscNotification(9, "4;1;50"), null);
    assert.equal(parseOscNotification(9, "4"), null);
  });

  it("reads OSC 777 notify;title;body, keeping semicolons in the body", () => {
    assert.deepEqual(parseOscNotification(777, "notify;Tests;2 failed; see log"), { title: "Tests", body: "2 failed; see log" });
    assert.equal(parseOscNotification(777, "preexec;something"), null);
  });

  it("strips control characters and ignores empty messages", () => {
    assert.deepEqual(parseOscNotification(9, "a\u0007b\u001b[1mc"), { title: null, body: "a b [1mc" });
    assert.equal(parseOscNotification(9, "   "), null);
  });
});

describe("notification preview", () => {
  it("flattens markdown and code blocks and truncates", () => {
    assert.equal(previewText("**Done.** Updated `notes.md`.\n\n```\ncode\n```\nAll good"), "Done. Updated notes.md. All good");
    assert.equal(previewText("x".repeat(200), 10), "xxxxxxxxx…");
    assert.equal(previewText(null), null);
  });
});
