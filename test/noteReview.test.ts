import { describe, it } from "node:test";
import assert from "node:assert";
import { composeFeedbackPrompt } from "../src/claude/feedbackPrompt";
import type { FeedbackItem } from "../src/state/FeedbackStore";

const base: FeedbackItem = {
  id: 1,
  token: "t",
  terminalLabel: "Terminal 1",
  filePath: "/vault/Notes/plan.md",
  oldLines: null,
  newLines: { start: 3, end: 4 },
  excerpt: "We ship on Friday.\nEveryone signs off first.",
  comment: "Make this a checklist.",
  rejected: false,
  createdAt: 0,
};
const rel = (p: string): string => p.replace("/vault/", "");

describe("comments on selected note text", () => {
  it("name the lines and the type, and quote the selection", () => {
    const prompt = composeFeedbackPrompt([{ ...base, intent: "change" }], rel);
    assert.match(prompt, /^A review comment on my notes:/);
    assert.match(prompt, /1\. Notes\/plan\.md, lines 3–4 \[Change\]/);
    assert.match(prompt, /> We ship on Friday\./);
    assert.match(prompt, /Make this a checklist\./);
    assert.doesNotMatch(prompt, /your version/);
  });

  it("tell Claude a Question isn't a request to edit, and a Keep needs no words", () => {
    const prompt = composeFeedbackPrompt(
      [
        { ...base, intent: "question", comment: "Is Friday fixed?" },
        { ...base, id: 2, intent: "keep", comment: "", newLines: { start: 7, end: 7 } },
      ],
      rel
    );
    assert.match(prompt, /^Review comments on my notes:/);
    assert.match(prompt, /\[Question: answer it, don't change the file for it\]/);
    assert.match(prompt, /2\. Notes\/plan\.md, line 7 \[Keep: leave these lines as they are\]/);
  });

  it("leave comments on Claude's edits worded as before, and mark a mix", () => {
    assert.match(composeFeedbackPrompt([{ ...base, oldLines: { start: 3, end: 4 } }], rel), /^Feedback on one of your edits:[\s\S]*lines 3–4 of your version/);
    assert.match(composeFeedbackPrompt([base, { ...base, id: 2, intent: "keep", comment: "" }], rel), /^Review comments:/);
  });
});

import { FeedbackStore } from "../src/state/FeedbackStore";

describe("queued comments", () => {
  const add = (store: FeedbackStore, token: string, comment: string, intent?: "change" | "question" | "keep") =>
    store.add({ token, terminalLabel: token, filePath: "/vault/a.md", oldLines: null, newLines: { start: 1, end: 1 }, excerpt: "x", comment, rejected: false, intent }, 0);

  it("reorder within a session, leaving other sessions' alone", () => {
    const store = new FeedbackStore();
    const a = add(store, "t1", "a");
    const other = add(store, "t2", "other");
    const b = add(store, "t1", "b");
    const c = add(store, "t1", "c");
    store.move("t1", c.id, a.id);
    assert.deepEqual(store.listFor("t1").map((i) => i.comment), ["c", "a", "b"]);
    store.move("t1", c.id, null);
    assert.deepEqual(store.listFor("t1").map((i) => i.comment), ["a", "b", "c"]);
    assert.deepEqual(store.listFor("t2").map((i) => i.id), [other.id]);
    void b;
  });

  it("edit text and type, and drop a comment emptied of words unless it's a Keep", () => {
    const store = new FeedbackStore();
    const q = add(store, "t1", "Why?", "question");
    store.edit(q.id, "", "keep");
    assert.equal(store.listFor("t1")[0]!.intent, "keep");
    store.edit(q.id, "", "change");
    assert.equal(store.listFor("t1").length, 0);
    const hunk = add(store, "t1", "Too long");
    store.edit(hunk.id, "Shorter please", "keep");
    assert.equal(store.listFor("t1")[0]!.intent, undefined, "a comment on Claude's edit has no type to change");
    assert.equal(store.listFor("t1")[0]!.comment, "Shorter please");
  });
});
