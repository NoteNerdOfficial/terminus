/**
 * Where a review pin belongs on a page that changes under it, worked out
 * in the page itself. The same rules as Vault Publisher's review overlay,
 * which settled them on real prototypes and decks.
 *
 * A pin used to show wherever its element had a box. That is right for a
 * plain document and wrong for most of what gets reviewed here:
 *
 *   - **A single-file deck** keeps every slide in the document and shows
 *     one, by a class, a `hidden` attribute or a style. A slide faded out
 *     with `opacity` or `visibility` still has a box, so its pins drew over
 *     whichever slide was up. So a pin records which page of the deck was
 *     showing (`view`) and draws only while that page is up.
 *   - **An app's screens** often share one file and tell themselves apart
 *     by the query or the fragment (`#/settings`). So a pin records that
 *     (`route`) and draws only on the same one.
 *   - **A dialog, sheet or menu** closes by being hidden, slid out of
 *     sight or taken out of the page. So a pin records the named thing it
 *     was inside (`context`), and draws only while its element is showing
 *     and can be seen through whatever clips it.
 *   - **A pin whose element scrolled out of the pane** was pushed onto its
 *     edge, so it looked like it belonged to whatever was there. Now it
 *     hides until the element is back.
 *
 * The element is found again by its selector, checked against its tag and
 * text, so an edit that inserts an element above it doesn't move the pin
 * onto its neighbour (see `resolve`).
 *
 * Both scripts run in the page through the DevTools protocol, so they're
 * plain JavaScript in strings, sharing `HELPERS`.
 */

/** Recorded when a pin is placed: which screen of the page it's on. */
export interface PinPlace {
  /** The query and fragment that tell an app's screens apart, normalized;
   *  null when the page had neither. */
  route: string | null;
  /** Which page of a deck that is one file was showing, or "" for a page
   *  that isn't a deck. */
  view: string;
  /** The dialog, panel or sheet the element was inside, or null. */
  context: string | null;
  /** The element's text, to find it again when its selector stops fitting. */
  text: string;
  /** The attributes that had `context` open, on it and a few levels up, to
   *  open it again for "Show on the page" once it has closed. */
  reveal?: Record<string, string>[];
}

/** What the page says about a pin now. */
export type PinState =
  /** Showing: its element's box in the viewport, and the part of the
   *  viewport the element can be seen through (null for all of it). */
  | { state: "shown"; x: number; y: number; width: number; height: number; clip: Clip | null; text?: string }
  /** On the page, but on another slide or screen, or hidden or out of sight. */
  | { state: "elsewhere" }
  /** Not on the page at all. */
  | { state: "missing" };

export interface Clip {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the page needs to find a pin's element and check it's showing. */
export interface PinQuery {
  selector: string;
  tag: string;
  place: PinPlace | null;
}

/** Shared by both scripts. Ported from Vault Publisher's overlayScript.ts. */
const HELPERS = String.raw`
  const VIEW_ATTRS = ["data-osp-view", "data-slide", "data-page", "data-view", "data-step", "data-index", "name", "aria-label"];
  const VIEW_SCAN_LIMIT = 600;
  const CONTEXT_LIMIT = 12;
  const POPUP_ROLES = /^(dialog|alertdialog|menu|listbox|tooltip)$/;
  const POPUP_CLASS = /(^|[-_])(modal|sheet|bottomsheet|drawer|popup|popover|dialog|dropdown|menu|toast|tooltip|overlay|lightbox|snackbar)([-_]|$)/i;
  const STATE_CLASS = /^(is|has)-|(^|[-_])(open|opened|active|show|shown|showing|visible|in|out|enter|entering|entered|leave|leaving|exit|exiting|hidden|closed|closing|expanded|collapsed|on|off|up|down|animating|animated|transition|transitioning|current|present|past|future|selected)$/i;
  const flat = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const textOf = (el) => flat(el.textContent, 200);

  // Vault Publisher's own overlay sits at the top of a page it serves; it
  // must not count as one of a deck's pages.
  const childElements = (node) =>
    Array.from(node && node.children ? node.children : []).filter((el) => el.id !== "osp-overlay-host");

  // Whether this element itself is shown, saying nothing about its parents.
  function shownSelf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (style.opacity === "0") return false;
    // display: contents draws no box of its own, but its children do.
    if (style.display === "contents") return true;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // Whether this element is shown, parents included.
  function showing(el) {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (!shownSelf(node)) return false;
    }
    return true;
  }

  // What a page of a deck is called: what its author named it, else where
  // it sits (with the count, so inserting a slide changes every key below
  // rather than handing one slide's name to the next).
  function viewKeyOf(el) {
    if (el.id) return "#" + el.id;
    for (const name of VIEW_ATTRS) {
      const value = el.getAttribute(name);
      if (value) return name + "=" + value;
    }
    const kids = childElements(el.parentNode);
    return el.tagName.toLowerCase() + ":" + kids.indexOf(el) + "/" + kids.length;
  }

  // Every run of same-tag siblings with exactly one shown and at least one
  // hidden: the signature of a deck, whatever built it.
  function deckGroups() {
    if (!document.body) return [];
    const found = [];
    const queue = [document.body];
    let seen = 0;
    while (queue.length && seen < VIEW_SCAN_LIMIT) {
      const kids = childElements(queue.shift());
      const groups = new Map();
      const shown = [];
      for (const kid of kids) {
        seen++;
        const up = shownSelf(kid);
        if (up) shown.push(kid);
        const tag = kid.tagName;
        if (!groups.has(tag)) groups.set(tag, { members: [], shown: [] });
        const group = groups.get(tag);
        group.members.push(kid);
        if (up) group.shown.push(kid);
      }
      for (const group of groups.values()) {
        if (group.shown.length === 1 && group.members.length > 1) found.push({ members: group.members, shown: group.shown[0] });
      }
      queue.push(...shown);
    }
    return found;
  }

  function currentViewKey(groups) {
    return groups.map((group) => viewKeyOf(group.shown)).sort().join(">");
  }

  // The query and fragment that tell an app's screens apart. A fragment
  // that names an element on the page is a place to scroll to, not a
  // screen, so it's left out; a token-shaped "t" (Vault Publisher's) too.
  function currentRoute() {
    const params = location.search.slice(1).split("&").filter((p) => p && !/^t=[a-z0-9]{24,32}$/i.test(p)).sort();
    let hash = location.hash.length > 1 ? location.hash : "";
    if (hash) {
      let id = hash.slice(1);
      try { id = decodeURIComponent(id); } catch (e) {}
      if (document.getElementById(id) || document.getElementsByName(id).length) hash = "";
    }
    const route = (params.length ? "?" + params.join("&") : "") + hash;
    return route || null;
  }

  function stableClasses(el) {
    return String(el.getAttribute("class") || "").split(/\s+/).filter((c) => c && !STATE_CLASS.test(c)).sort();
  }

  // A name for a sheet, popup or menu nobody named: what it says it is,
  // without the classes that only say whether it's open.
  function popupKeyOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const classes = stableClasses(el);
    const says = tag === "dialog" || POPUP_ROLES.test(role) || el.getAttribute("aria-modal") === "true" ||
      el.hasAttribute("popover") || classes.some((c) => POPUP_CLASS.test(c));
    if (!says) return "";
    if (classes.length) return "~" + tag + "." + classes.join(".");
    if (role) return "~" + tag + "[role=" + role + "]";
    return "~" + tag;
  }

  function contextKeyOf(el) {
    if (el.id) return "#" + el.id;
    for (const name of VIEW_ATTRS) {
      const value = el.getAttribute(name);
      if (value) return name + "=" + value;
    }
    return popupKeyOf(el);
  }

  // The nearest named thing an element is inside, a few levels up at most:
  // further up is the app's outer frame, which never closes.
  function contextOf(node) {
    let up = 0;
    for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
      if (el === document.body || el === document.documentElement) break;
      if (++up > CONTEXT_LIMIT) break;
      const key = contextKeyOf(el);
      if (key) return { key, el };
    }
    return null;
  }

  function contextNodes(key) {
    if (!key) return [];
    if (key[0] === "#") {
      const one = document.getElementById(key.slice(1));
      return one ? [one] : [];
    }
    if (key[0] === "~") {
      const tag = key.slice(1).split(/[.[]/)[0] || "*";
      return Array.from(document.getElementsByTagName(tag)).filter((el) => popupKeyOf(el) === key);
    }
    const eq = key.indexOf("=");
    if (eq === -1) return [];
    const name = key.slice(0, eq);
    const value = key.slice(eq + 1);
    let found = [];
    try { found = Array.from(document.querySelectorAll("[" + name + "]")); } catch (e) { return []; }
    return found.filter((el) => el.getAttribute(name) === value);
  }

  // What clips an element: ancestors that hide their overflow, and the
  // window for something held to it. The document itself isn't a clip: a
  // paragraph below the fold is on the page.
  function clipOf(el) {
    let clip = null;
    const cut = (box) => {
      if (!clip) { clip = { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; return; }
      clip.left = Math.max(clip.left, box.left);
      clip.top = Math.max(clip.top, box.top);
      clip.right = Math.min(clip.right, box.right);
      clip.bottom = Math.min(clip.bottom, box.bottom);
    };
    let fixed = getComputedStyle(el).position === "fixed";
    for (let at = el.parentElement; at; at = at.parentElement) {
      if (at === document.body || at === document.documentElement) break;
      const style = getComputedStyle(at);
      if (style.position === "fixed") fixed = true;
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const box = at.getBoundingClientRect();
        if (box.width || box.height) cut(box);
      }
    }
    if (fixed) cut({ left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    return clip;
  }

  function inSight(el) {
    const clip = clipOf(el);
    if (!clip) return true;
    const box = el.getBoundingClientRect();
    const w = Math.min(box.right, clip.right) - Math.max(box.left, clip.left);
    const h = Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top);
    return w > 1 && h > 1;
  }

  function contextShowing(key) {
    return contextNodes(key).some((el) => showing(el) && inSight(el));
  }

  // The element again: by its selector while that still finds an element
  // of the same tag and text; else the one element anywhere with that tag
  // and text (it moved); else the selector's, if the tag still fits (its
  // text was edited, which is what a Change asks for).
  function resolve(q) {
    let el = null;
    try { el = document.querySelector(q.selector); } catch (e) {}
    const sameTag = !!el && el.tagName.toLowerCase() === q.tag;
    const text = q.place ? q.place.text : "";
    if (sameTag && (!text || textOf(el) === text)) return { el };
    if (text) {
      const matches = Array.from(document.getElementsByTagName(q.tag)).filter((m) => textOf(m) === text);
      const pick = matches.length === 1 ? matches : matches.filter(showing);
      if (pick.length === 1) return { el: pick[0] };
    }
    return sameTag ? { el, adopted: true } : null;
  }

  // What has a context open: a few attributes, on it and its ancestors.
  const REVEAL_ATTRS = ["class", "style", "hidden", "open", "inert", "aria-hidden", "aria-expanded", "data-state", "data-open", "data-visible"];
  const REVEAL_DEPTH = 4;
  function revealStateOf(holder) {
    const out = [];
    let el = holder;
    for (let level = 0; level < REVEAL_DEPTH; level++) {
      if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) break;
      const attrs = {};
      for (const name of REVEAL_ATTRS) {
        const value = el.getAttribute(name);
        if (value !== null) attrs[name] = value.slice(0, 600);
      }
      out.push(attrs);
      el = el.parentElement;
    }
    return out;
  }
`;

/**
 * Runs with `this` as the picked element: the PinPlace to record with it.
 */
export const PLACE_OF = String.raw`function () {
  ${HELPERS}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const context = contextOf(el);
  const place = { route: currentRoute(), view: currentViewKey(deckGroups()), context: context ? context.key : null, text: textOf(el) };
  if (context) place.reveal = revealStateOf(context.el);
  return place;
}`;

/**
 * Runs with `this` as the element the browser's hit test found at (x, y):
 * that element when it's showing, else the first showing element at that
 * point. The hit test counts elements that can't be seen -- a deck's
 * faded-out slides, stacked over the one that's up -- so picking on a slide
 * picked the last slide in the deck instead.
 */
export const SHOWN_AT = String.raw`function (x, y) {
  ${HELPERS}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el && showing(el)) return el;
  for (const candidate of document.elementsFromPoint(x, y)) {
    if (showing(candidate)) return candidate;
  }
  return el;
}`;

/**
 * Runs in the page with a list of PinQuery: a PinState for each.
 */
export const PINS_FOR = String.raw`function (queries) {
  ${HELPERS}
  let groups = null;
  let viewKey = null;
  let route;
  const deck = () => groups || (groups = deckGroups());
  const view = () => (viewKey === null ? (viewKey = currentViewKey(deck())) : viewKey);

  // On the page of the deck it was left on: the same pages up, or the
  // named ones it was left on still showing, or its own element showing
  // inside the page that's up (a key can differ over a banner that rotates).
  function onThisView(place, el) {
    if (!place.view || place.view === view()) return true;
    const parts = place.view.split(">");
    if (parts.every((part) => contextNodes(part).some((n) => showing(n) && inSight(n)))) return true;
    return deck().some((group) => group.shown.contains(el));
  }

  // Still inside the thing it was left in, and that's open.
  function inContext(place, el) {
    if (!place.context) return true;
    for (let at = el, up = 0; at && at.nodeType === 1 && up <= CONTEXT_LIMIT; at = at.parentElement, up++) {
      if (contextKeyOf(at) === place.context) return showing(at) && inSight(at);
    }
    // Moved out of it, or it's named differently now: whether it's open.
    return contextShowing(place.context);
  }

  return queries.map((q) => {
    const place = q.place;
    if (place) {
      if (route === undefined) route = currentRoute();
      if ((place.route || null) !== route) return { state: "elsewhere" };
    }
    const found = resolve(q);
    if (!found) return { state: "missing" };
    const el = found.el;
    if (!showing(el)) return { state: "elsewhere" };
    if (place && (!onThisView(place, el) || !inContext(place, el))) return { state: "elsewhere" };
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { state: "elsewhere" };
    const shown = { state: "shown", x: r.left, y: r.top, width: r.width, height: r.height, clip: clipOf(el) };
    // Its text was edited in place: remember the new text, once the page
    // has finished loading, so the next look finds it straight away.
    if (found.adopted && document.readyState === "complete") shown.text = textOf(el);
    return shown;
  });
}`;

/**
 * Runs in the page with one PinQuery: takes the user to its element,
 * wherever on the page it is, the way Vault Publisher's overlay does.
 *
 *   - On another page of a deck: turns the deck to that page, by swapping
 *     the attributes that make one page shown and the others hidden
 *     between the page that's up and the one wanted. The deck has no
 *     method to call, and this is the change it makes itself, so its own
 *     Prev and Next still work afterwards.
 *   - In a dialog or sheet that has closed: puts back the attributes that
 *     had it open. Undone when the next note is shown, where the page
 *     hasn't changed them since.
 *   - Then scrolls it into view.
 *
 * Returns "route" when the note is on another screen (the caller goes
 * there and asks again), "missing" when the element isn't on the page,
 * "shown" when it's now on screen, else "hidden".
 */
export const GO_TO_PIN = String.raw`function (q) {
  ${HELPERS}
  const VIEW_STATE_ATTRS = ["class", "style", "hidden", "open", "aria-hidden", "aria-selected", "aria-current", "aria-expanded",
    "data-active", "data-state", "data-current", "data-visible"];
  const swap = (a, b) => {
    for (const name of VIEW_STATE_ATTRS) {
      const from = a.getAttribute(name);
      const to = b.getAttribute(name);
      if (from === to) continue;
      if (to === null) a.removeAttribute(name); else a.setAttribute(name, to);
      if (from === null) b.removeAttribute(name); else b.setAttribute(name, from);
    }
  };

  // The last note's dialog, put back the way the page had it.
  const last = window.__terminusPeek;
  window.__terminusPeek = null;
  if (last) {
    for (const change of last.slice().reverse()) {
      if (!change.el.isConnected || change.el.getAttribute(change.name) !== change.after) continue;
      if (change.before === null) change.el.removeAttribute(change.name); else change.el.setAttribute(change.name, change.before);
    }
  }

  const place = q.place;
  if (place && (place.route || null) !== currentRoute()) return "route";

  // Turn the deck, a level at a time: an inner deck is only found once the
  // outer one is on the right page.
  if (place && place.view) {
    const wanted = place.view.split(">");
    for (let round = 0; round < 4; round++) {
      if (currentViewKey(deckGroups()) === place.view) break;
      let moved = false;
      for (const group of deckGroups()) {
        if (wanted.includes(viewKeyOf(group.shown))) continue;
        const member = group.members.find((m) => m !== group.shown && wanted.includes(viewKeyOf(m)));
        if (member) { swap(group.shown, member); moved = true; }
      }
      if (!moved) break;
    }
  }

  const found = resolve(q);
  if (!found) return "missing";
  const el = found.el;

  // Open the dialog it was left in, if that has closed.
  if (place && place.context && place.reveal && place.reveal.length && !(showing(el) && inSight(el))) {
    const holders = contextNodes(place.context);
    const holder = holders.find((h) => h.contains(el)) || holders[0];
    const changes = [];
    let at = holder;
    for (const saved of place.reveal) {
      if (!at || at.nodeType !== 1 || at === document.body) break;
      for (const name of REVEAL_ATTRS) {
        const want = Object.prototype.hasOwnProperty.call(saved, name) ? saved[name] : null;
        const have = at.getAttribute(name);
        if (want === have) continue;
        changes.push({ el: at, name, before: have, after: want });
        if (want === null) at.removeAttribute(name); else at.setAttribute(name, want);
      }
      at = at.parentElement;
    }
    if (changes.length) window.__terminusPeek = changes;
  }

  el.scrollIntoView({ block: "center", inline: "center" });
  return showing(el) && inSight(el) ? "shown" : "hidden";
}`;

export function isPinPlace(value: unknown): value is PinPlace {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    (p.route === null || typeof p.route === "string") &&
    typeof p.view === "string" &&
    (p.context === null || typeof p.context === "string") &&
    typeof p.text === "string"
  );
}

export function isPinState(value: unknown): value is PinState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.state === "elsewhere" || s.state === "missing") return true;
  return s.state === "shown" && [s.x, s.y, s.width, s.height].every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Whether a pin's tip, at (x, y) in the viewport, is somewhere it can be
 * seen: inside the viewport and inside whatever clips its element. A
 * little slack, so a pin on the very edge doesn't flicker.
 */
export function pinInSight(x: number, y: number, clip: Clip | null, viewport: { width: number; height: number }): boolean {
  const slack = 2;
  if (x < -slack || y < -slack || x > viewport.width + slack || y > viewport.height + slack) return false;
  if (!clip) return true;
  if (clip.right <= clip.left || clip.bottom <= clip.top) return false;
  return x >= clip.left - slack && x <= clip.right + slack && y >= clip.top - slack && y <= clip.bottom + slack;
}
