import { describe, it } from "node:test";
import assert from "node:assert";
import { BrowserSiteRegistry, withoutQuery } from "../src/browser/sites";
import { ReviewBook, composeReviewPrompt, diffFingerprints, elementLabel, inlineCode, siteOfPageKey, type PickedElement } from "../src/browser/review";

const BUTTON: PickedElement = {
  selector: "form > button:nth-of-type(2)",
  tag: "button",
  role: "",
  name: "",
  text: "Create account",
  html: '<button class="primary">Create account</button>',
};

function book(): ReviewBook {
  let now = 1000;
  return new ReviewBook(() => now++);
}

function addNote(b: ReviewBook, text = "Too close to the field above", pageKey = "file:/vault/proto/index.html") {
  return b.add({
    pageKey,
    pageUrl: "proto/index.html",
    href: "http://127.0.0.1:1/serve/x/index.html",
    pageTitle: "Sign up",
    sourcePath: "/vault/proto/index.html",
    element: BUTTON,
    intent: "change",
    text,
    screenshotPath: "/tmp/terminus-browser/review-b1.png",
  });
}

describe("site registry", () => {
  const site = { id: "vault-publisher-preview", name: "Vault Publisher preview", open: async () => "http://127.0.0.1:5000/?t=secret" };

  it("registers, lists and unregisters", () => {
    const registry = new BrowserSiteRegistry();
    const off = registry.register(site);
    assert.deepEqual(
      registry.list().map((s) => s.id),
      ["vault-publisher-preview"]
    );
    off();
    assert.equal(registry.get(site.id), undefined);
  });

  it("an old unregister doesn't remove a newer registration", () => {
    const registry = new BrowserSiteRegistry();
    const off = registry.register(site);
    registry.register({ ...site, name: "Newer" });
    off();
    assert.equal(registry.get(site.id)?.name, "Newer");
  });

  it("refuses bad ids and missing open()", () => {
    const registry = new BrowserSiteRegistry();
    assert.throws(() => registry.register({ ...site, id: "Has Spaces" }));
    assert.throws(() => registry.register({ ...site, id: "../x" }));
    assert.throws(() => registry.register({ id: "ok", name: "x" } as never));
  });

  it("drops the query (and its token) from a shown address", () => {
    assert.equal(withoutQuery("http://127.0.0.1:5000/a.html?t=secret#x"), "http://127.0.0.1:5000/a.html");
    assert.equal(withoutQuery("http://127.0.0.1:5000/"), "http://127.0.0.1:5000/");
  });
});

describe("review notes", () => {
  it("go open -> sent -> fixed -> resolved", () => {
    const b = book();
    const note = addNote(b);
    assert.equal(note.id, "n1");
    assert.equal(note.status, "open");
    b.markSent([note.id], "tok");
    assert.equal(b.get("n1")!.status, "sent");
    assert.equal(b.get("n1")!.sentTo, "tok");
    b.reply("n1", "Added 16px of space", "Claude", true);
    assert.equal(b.get("n1")!.status, "fixed");
    b.resolve("n1");
    assert.equal(b.get("n1")!.status, "resolved");
    assert.throws(() => b.reply("n1", "again", "Claude", false));
  });

  it("a follow-up reopens a note and keeps the thread", () => {
    const b = book();
    addNote(b);
    b.markSent(["n1"], "tok");
    b.reply("n1", "Done", "Claude", true);
    b.followUp("n1", "Still too tight on mobile");
    const note = b.get("n1")!;
    assert.equal(note.status, "open");
    assert.deepEqual(
      note.thread.map((e) => e.by),
      ["user", "agent", "user"]
    );
    // An unsent follow-up can still be edited; a sent note can't.
    b.edit("n1", "Still too tight on phones", "change");
    assert.equal(b.get("n1")!.thread[2]!.text, "Still too tight on phones");
    b.markSent(["n1"], "tok");
    assert.throws(() => b.edit("n1", "x", "change"));
  });

  it("an answer without --fixed is 'answered'", () => {
    const b = book();
    addNote(b);
    b.reply("n1", "Because the grid uses 8px steps", "Claude", false);
    assert.equal(b.get("n1")!.status, "answered");
  });

  it("refuses empty notes and clears only done ones when asked", () => {
    const b = book();
    assert.throws(() => addNote(b, "   "));
    addNote(b);
    addNote(b, "Second");
    b.resolve("n1");
    assert.equal(b.clear("file:/vault/proto/index.html", true), 1);
    assert.deepEqual(
      b.all().map((n) => n.id),
      ["n2"]
    );
  });

  it("groups pages by site", () => {
    assert.equal(siteOfPageKey("file:/vault/proto/a/index.html"), "file:/vault/proto/a");
    assert.equal(siteOfPageKey("site:vault-publisher-preview:/notes/x.html"), "site:vault-publisher-preview:");
    assert.equal(siteOfPageKey("http://localhost:5173/settings"), "http://localhost:5173");
  });
});

describe("review prompt", () => {
  it("lists each note with its element, file and how to reply", () => {
    const b = book();
    addNote(b);
    const prompt = composeReviewPrompt(b.all(), { browserId: "b2", canReply: true, showPath: (p) => p.replace("/vault/", "") });
    assert.match(prompt, /### n1 · Change · button "Create account"/);
    assert.match(prompt, /File: `proto\/index\.html`/);
    assert.match(prompt, /Selector: `form > button:nth-of-type\(2\)`/);
    assert.match(prompt, /browser reply b2 n1 .* --fixed/);
  });

  it("asks for a plain reply when the agent can't use the browser", () => {
    const b = book();
    addNote(b);
    const prompt = composeReviewPrompt(b.all(), { browserId: null, canReply: false, showPath: (p) => p });
    assert.doesNotMatch(prompt, /TERMINUS_CLI/);
    assert.match(prompt, /Reply with what you did for each Change and Question note/);
  });

  it("carries the earlier thread on a follow-up", () => {
    const b = book();
    addNote(b);
    b.reply("n1", "Added space", "Claude", true);
    b.followUp("n1", "Still tight");
    const prompt = composeReviewPrompt(b.all(), { browserId: "b1", canReply: true, showPath: (p) => p });
    assert.match(prompt, /> Me: Too close/);
    assert.match(prompt, /> Claude: Added space/);
    assert.match(prompt, /Now: Still tight/);
  });

  it("keeps the page's backticks from breaking out of code", () => {
    assert.equal(inlineCode("a`b"), "``a`b``");
    assert.equal(elementLabel({ ...BUTTON, name: "Save" }), 'button "Save"');
  });
});

describe("keep", () => {
  const look = (text: string, color = "rgb(0, 0, 0)") => ({ text, attrs: { class: "title" }, styles: { color } });

  function keep(b: ReviewBook, text = "") {
    return b.add({
      pageKey: "file:/vault/proto/index.html",
      pageUrl: "proto/index.html",
      href: "http://127.0.0.1:1/serve/x/index.html",
      pageTitle: "Sign up",
      sourcePath: null,
      element: BUTTON,
      intent: "keep",
      text,
      screenshotPath: null,
      baseline: look("Create account"),
    });
  }

  it("needs no text, but other types do", () => {
    const b = book();
    assert.equal(keep(b).thread.length, 0);
    assert.throws(() => addNote(b, ""));
  });

  it("can't be answered by an agent", () => {
    const b = book();
    keep(b);
    assert.throws(() => b.reply("n1", "ok", "Claude", false), /Keep/);
  });

  it("notices a change, once, and clears when it's back", () => {
    const b = book();
    keep(b);
    assert.equal(b.checkKeep("n1", look("Create account")), false);
    assert.equal(b.checkKeep("n1", look("Sign up", "rgb(255, 0, 0)")), true);
    assert.deepEqual(b.get("n1")!.drift!.changes, ['text: "Create account" → "Sign up"', 'color: "rgb(0, 0, 0)" → "rgb(255, 0, 0)"']);
    assert.equal(b.checkKeep("n1", look("Sign up", "rgb(255, 0, 0)")), false, "same change isn't news");
    assert.equal(b.checkKeep("n1", look("Create account")), false);
    assert.equal(b.get("n1")!.drift, null);
  });

  it("says when the element is gone, and accepting that removes the Keep", () => {
    const b = book();
    keep(b);
    assert.equal(b.checkKeep("n1", null), true);
    assert.deepEqual(b.get("n1")!.drift!.changes, ["the element is gone from the page"]);
    b.acceptDrift("n1");
    assert.equal(b.get("n1"), undefined);
  });

  it("accepting a new look makes it the baseline", () => {
    const b = book();
    keep(b);
    b.checkKeep("n1", look("Sign up"));
    b.acceptDrift("n1");
    assert.equal(b.get("n1")!.baseline!.text, "Sign up");
    assert.equal(b.checkKeep("n1", look("Sign up")), false);
  });

  it("tells the agent not to touch it and not to answer it, and asks for a restore after a change", () => {
    const b = book();
    addNote(b);
    keep(b);
    b.checkKeep("n2", look("Sign up"));
    const prompt = composeReviewPrompt(b.all(), { browserId: "b1", canReply: true, showPath: (p) => p });
    assert.match(prompt, /### n2 · Keep -- leave this element as it is/);
    assert.match(prompt, /Keep notes need no answer/);
    assert.match(prompt, /browser reply b1 n1 /);
    assert.doesNotMatch(prompt, /browser reply b1 n2 /);
    assert.match(prompt, /It changed, and shouldn't have: text: "Create account" → "Sign up"\. Put it back/);
  });

  it("repeats earlier Keeps when new notes are sent", () => {
    const b = book();
    keep(b);
    b.markSent(["n1"], "tok");
    addNote(b);
    const prompt = composeReviewPrompt([b.get("n2")!], { browserId: "b1", canReply: true, showPath: (p) => p, standingKeeps: [b.get("n1")!] });
    assert.match(prompt, /## Still keep, from before/);
    assert.match(prompt, /- n1 · button "Create account"/);
    assert.match(prompt, /^I left a review note/);
  });
});

describe("keep at another page width", () => {
  it("ignores sizes a fluid layout changes, but not text or colour", () => {
    const before = { text: "Accounts", attrs: {}, styles: { "font-size": "36px", color: "black" }, viewport: 800 };
    assert.deepEqual(diffFingerprints(before, { ...before, styles: { "font-size": "31px", color: "black" }, viewport: 600 }), []);
    assert.deepEqual(diffFingerprints(before, { ...before, styles: { "font-size": "31px", color: "black" }, viewport: 800 }), ['font-size: "36px" → "31px"']);
    assert.deepEqual(diffFingerprints(before, { ...before, styles: { "font-size": "31px", color: "red" }, viewport: 600 }), ['color: "black" → "red"']);
  });
});
