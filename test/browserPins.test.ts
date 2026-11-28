import { describe, it } from "node:test";
import assert from "node:assert";
import { pageDependsOn } from "../src/browser/pageFiles";
import { BrowserSiteRegistry } from "../src/browser/sites";
import { ReviewBook, composeReviewPrompt } from "../src/browser/review";
import { isPinPlace, isPinState, pinInSight } from "../src/browser/pinPlace";

describe("which file changes reload a page", () => {
  const vault = ["/Users/me/vault"];

  it("reloads for the page's own file", () => {
    assert.equal(pageDependsOn("/Users/me/vault/notes/plan.md", "/Users/me/vault/notes/plan.md", vault), true);
    assert.equal(pageDependsOn("/Users/me/vault/site/deck.html", "/Users/me/vault/site/deck.html", vault), true);
  });

  it("reloads an HTML page for the files in its folder and below", () => {
    assert.equal(pageDependsOn("/Users/me/vault/site/deck.html", "/Users/me/vault/site/deck.css", vault), true);
    assert.equal(pageDependsOn("/Users/me/vault/site/deck.html", "/Users/me/vault/site/js/app.js", vault), true);
  });

  it("doesn't reload for notes beside it, files elsewhere, or a note's neighbours", () => {
    assert.equal(pageDependsOn("/Users/me/vault/site/deck.html", "/Users/me/vault/site/todo.md", vault), false);
    assert.equal(pageDependsOn("/Users/me/vault/site/deck.html", "/Users/me/vault/other/deck.css", vault), false);
    assert.equal(pageDependsOn("/Users/me/vault/site/deck.html", "/Users/me/vault/sitemap/deck.css", vault), false);
    assert.equal(pageDependsOn("/Users/me/vault/notes/plan.md", "/Users/me/vault/notes/plan.css", vault), false);
  });

  it("treats a page at the top of the vault as only its own file", () => {
    assert.equal(pageDependsOn("/Users/me/vault/index.html", "/Users/me/vault/site/deck.css", vault), false);
    assert.equal(pageDependsOn("/Users/me/vault/index.html", "/Users/me/vault/index.html", vault), true);
  });
});

describe("site refresh", () => {
  it("passes a site's refresh through, and leaves it out when there's none", async () => {
    const registry = new BrowserSiteRegistry();
    const asked: string[] = [];
    registry.register({ id: "built", name: "Built", open: async () => "http://127.0.0.1:1/", refresh: async (url) => void asked.push(url) });
    registry.register({ id: "plain", name: "Plain", open: async () => "http://127.0.0.1:2/" });
    await registry.get("built")!.refresh!("http://127.0.0.1:1/notes/plan.html");
    assert.deepEqual(asked, ["http://127.0.0.1:1/notes/plan.html"]);
    assert.equal(registry.get("plain")!.refresh, undefined);
  });
});

describe("pin places", () => {
  const place = { route: "?tab=home", view: "#slide-2", context: null, text: "Revenue grew" };

  it("keeps the place a note was left on", () => {
    const book = new ReviewBook(() => 1);
    const note = book.add({
      pageKey: "file:/vault/deck/index.html",
      pageUrl: "deck/index.html",
      href: "http://127.0.0.1:1/serve/x/index.html",
      pageTitle: "Deck",
      sourcePath: null,
      element: { selector: "section:nth-of-type(2) > h2", tag: "h2", role: "", name: "", text: "Revenue grew", html: "<h2>" },
      intent: "change",
      text: "Say by how much",
      screenshotPath: null,
      place,
    });
    assert.deepEqual(note.place, place);
  });

  it("takes on the element's new text without telling anyone", () => {
    const book = new ReviewBook(() => 1);
    const note = book.add({
      pageKey: "k",
      pageUrl: "u",
      href: "h",
      pageTitle: "",
      sourcePath: null,
      element: { selector: "h2", tag: "h2", role: "", name: "", text: "Revenue grew", html: "" },
      intent: "change",
      text: "Say by how much",
      screenshotPath: null,
      place,
    });
    let heard = 0;
    book.onChange(() => heard++);
    book.retext(note.id, "Revenue grew 12%");
    assert.equal(book.get(note.id)!.place!.text, "Revenue grew 12%");
    assert.equal(heard, 0);
  });

  it("checks what the page sends back", () => {
    assert.equal(isPinPlace(place), true);
    assert.equal(isPinPlace({ route: null, view: "", context: null }), false);
    assert.equal(isPinState({ state: "elsewhere" }), true);
    assert.equal(isPinState({ state: "elsewhere", kind: "view", where: "slide 2 of 3" }), true);
    assert.equal(isPinState({ state: "shown", x: 1, y: 2, rect: null, clip: null, lost: "rewritten" }), true);
    assert.equal(isPinState({ state: "shown", x: Infinity, y: 2, rect: null, clip: null }), false);
    assert.equal(isPinState({ state: "missing", why: "duplicate" }), true);
    assert.equal(isPinState({ state: "missing" }), false);
    assert.equal(isPinState(null), false);
  });
});

describe("whether a pin can be seen", () => {
  const viewport = { width: 800, height: 600 };

  it("hides a pin scrolled out of the pane rather than pinning it to the edge", () => {
    assert.equal(pinInSight(100, 100, null, viewport), true);
    assert.equal(pinInSight(100, -40, null, viewport), false);
    assert.equal(pinInSight(1200, 100, null, viewport), false);
  });

  it("hides a pin outside what clips its element", () => {
    const clip = { left: 0, top: 0, right: 400, bottom: 300 };
    assert.equal(pinInSight(200, 200, clip, viewport), true);
    assert.equal(pinInSight(500, 200, clip, viewport), false);
    assert.equal(pinInSight(200, 200, { left: 0, top: 0, right: 0, bottom: 0 }, viewport), false);
  });
});

describe("a comment inside a frame", () => {
  it("tells the agent which frame the selector belongs to", () => {
    const book = new ReviewBook(() => 1);
    const note = book.add({
      pageKey: "file:/vault/phone/index.html",
      pageUrl: "phone/index.html",
      href: "http://127.0.0.1:1/serve/x/index.html",
      pageTitle: "Phone",
      sourcePath: null,
      element: { selector: "#count", tag: "p", role: "", name: "", text: "3 results", html: "<p id=count>" },
      intent: "change",
      text: "Bold the number",
      screenshotPath: null,
      place: { route: null, view: "", context: "~div.sheet", text: "3 results", frame: { path: ["#screen"], route: "/phone/app.html", src: "/phone/app.html" } },
    });
    const prompt = composeReviewPrompt([note], { browserId: null, canReply: false, showPath: (p) => p });
    assert.match(prompt, /In a frame showing: `\/phone\/app\.html`/);
  });
});
