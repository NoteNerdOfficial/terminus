import { describe, it } from "node:test";
import assert from "node:assert";
import { NoteKeeps, locateKeep } from "../src/review/noteKeeps";

const FILE = "/vault/Notes/plan.md";
const NOTE = "# Plan\n\nWe ship on Friday.\nEveryone signs off first.\n";

function keeps(): NoteKeeps {
  const k = new NoteKeeps(() => 1);
  k.add({ filePath: FILE, text: "Everyone signs off first.", line: 4, reason: "Legal asked for it" });
  return k;
}

describe("note keeps", () => {
  it("are broken only by an edit that takes the kept text away", () => {
    const k = keeps();
    assert.deepEqual(k.checkEdit(FILE, NOTE, NOTE.replace("Friday", "Monday"), "Terminal 1"), []);
    const broken = k.checkEdit(FILE, NOTE, NOTE.replace("Everyone signs off first.", "Sign-off is optional."), "Terminal 1");
    assert.equal(broken.length, 1);
    assert.equal(k.brokenIn(FILE)[0]!.broken!.by, "Terminal 1");
  });

  it("aren't set off when the text was already gone before Claude's edit", () => {
    const k = keeps();
    const mine = NOTE.replace("Everyone signs off first.", "I changed this myself.");
    assert.deepEqual(k.checkEdit(FILE, mine, mine + "More.\n", "Terminal 1"), []);
  });

  it("survive edits that move them, and mend when the text comes back", () => {
    const k = keeps();
    assert.deepEqual(k.checkEdit(FILE, NOTE, "Intro.\n\n" + NOTE, "T"), []);
    k.checkEdit(FILE, NOTE, "# Plan\n", "T");
    assert.equal(k.brokenIn(FILE).length, 1);
    k.recheck(FILE, NOTE);
    assert.equal(k.brokenIn(FILE).length, 0);
  });

  it("keep one entry for the same passage kept twice", () => {
    const k = keeps();
    k.add({ filePath: FILE, text: "Everyone signs off first.", line: 4, reason: "" });
    assert.equal(k.forFile(FILE).length, 1);
    assert.equal(k.forFile(FILE)[0]!.reason, "Legal asked for it");
  });

  it("are found again by text, nearest the line they were kept on", () => {
    const doc = "a\nsame\nb\nsame\n";
    const lineOf = (offset: number): number => doc.slice(0, offset).split("\n").length;
    assert.deepEqual(locateKeep(doc, { text: "same", line: 4 }, lineOf), { from: 9, to: 13 });
    assert.deepEqual(locateKeep(doc, { text: "same", line: 1 }, lineOf), { from: 2, to: 6 });
    assert.equal(locateKeep(doc, { text: "gone", line: 1 }, lineOf), null);
  });
});
