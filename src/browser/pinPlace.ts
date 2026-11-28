/**
 * Where a review pin belongs on a page that changes under it, worked out
 * in the page itself. A port of Vault Publisher's review overlay, which
 * settled these rules on real prototypes, decks and apps.
 *
 *   - **What a pin is on.** The nearest element that says what it is (a
 *     paragraph, heading, list item, button, link, section, row, anything
 *     with a role; never a bare `div` or `span`, which name nothing), known
 *     by a hash of its tag and text rather than by where it sits, so
 *     inserting an element above it doesn't move the pin onto a neighbour.
 *     Two alike get a numbered suffix; a pin whose suffix renumbered is put
 *     back on the one unclaimed element with that text, and never guessed
 *     at when two are left. The rows of anything that scrolls count too.
 *   - **Which screen it's on.** The query and fragment that tell an app's
 *     screens apart (`route`); the page of a deck that is one file, every
 *     page in the document and one shown (`view`); the dialog, sheet or
 *     menu it was in (`context`). A pin draws only there.
 *   - **Frames.** A prototype drawn inside a device, in an <iframe>: the
 *     pin records the frame and the screen it showed, and is placed and
 *     clipped through the frame's glass, scaled or not.
 *   - **When its element is gone.** On an app, text changes for reasons
 *     nobody edited (a counter, a filter), so the pin stays where it was
 *     dropped: as a fraction of its dialog, of the device's glass, or of
 *     the page. The card says why it was lost.
 *   - **Getting back to it** (`GO_TO_PIN`): to its screen, its slide (by
 *     the deck's own shown/hidden state, swapped), its dialog (by the
 *     attributes that had it open); or, where only clicks get there, the
 *     clicks that led to it, offered to the user to repeat (`TAP_RECORDER`).
 *
 * Every script runs in the page through the DevTools protocol, so they're
 * plain JavaScript in strings sharing `HELPERS`. They take the document
 * they work in, never assume the global one: a picked element inside a
 * frame is described from the frame's own context, and pins are placed
 * from the top page's.
 */

/** Recorded when a pin is placed: what it's on and which screen. */
export interface PinPlace {
  /** The top page's query and fragment that tell an app's screens apart,
   *  normalized; null when it had neither. */
  route: string | null;
  /** Which page of a deck was showing in the pin's document, or "". */
  view: string;
  /** The dialog, panel or sheet it was inside, or null. */
  context: string | null;
  /** The picked element's text, for the selector fallback. */
  text: string;
  /** The attributes that had `context` open, on it and a few levels up. */
  reveal?: Record<string, string>[];
  /** The element the pin is on: tag-and-text hash with its suffix. Null
   *  when nothing near the click says what it is. */
  block?: string | null;
  /** Where on the block (else the picked element) the click was. */
  rx?: number;
  ry?: number;
  /** Where on the picked element itself, for the selector fallback. */
  erx?: number;
  ery?: number;
  /** Where in its context, for when the block is gone. */
  cx?: number;
  cy?: number;
  /** The frame it's in, outermost first, and the screen it showed. */
  frame?: { path: string[]; route: string; src: string } | { crossOrigin: true } | null;
  /** Where on the frame's glass, for when the block is gone. */
  fx?: number;
  fy?: number;
  /** Where on the top page, in document coordinates. */
  px?: number;
  py?: number;
  /** The clicks that led to this screen since its address was last what
   *  it is now, to offer to repeat (see TAP_RECORDER). */
  trail?: TrailStep[];
  /** The picked element's box in the top page's viewport when picked. */
  rect?: Box;
}

export interface TrailStep {
  path: string[];
  block: string;
  text: string;
}

/** Why a pin's element couldn't be found. */
export type LostReason = "duplicate" | "rewritten" | "other-sheet" | "cross-origin" | "no-frame";

/** What the page says about a pin now. */
export type PinState =
  /** Drawn: the tip at (x, y) in the viewport; its element's box (null
   *  when it's drawn at a stored point because the element is gone); what
   *  clips it. */
  | { state: "shown"; x: number; y: number; rect: Box | null; clip: Clip | null; lost?: LostReason; text?: string }
  /** On another slide, screen or dialog of the page, or out of sight. */
  | { state: "elsewhere"; where?: string; kind?: "screen" | "view" | "closed" }
  /** Not on the page, and nowhere to draw it. */
  | { state: "missing"; why: LostReason };

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Clip {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the page needs to find a pin's element. */
export interface PinQuery {
  selector: string;
  tag: string;
  place: PinPlace | null;
}

/** What "Show on the page" found. */
export type GoResult =
  | { result: "shown" | "hidden" | "missing" }
  /** On another screen of the top page: go to its route and ask again. */
  | { result: "route" }
  /** A frame was sent to the screen; ask again once it has loaded. */
  | { result: "frame" }
  /** Only clicks get there: this many, for the user to choose to repeat. */
  | { result: "trail"; steps: number };

/** Shared by every script. */
const HELPERS = String.raw`
  const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, table, figure, pre, .callout, " +
    "main, header, footer, nav, aside, section, article, dialog, form, fieldset, details, summary, button, a, label, td, th, [role]";
  const VIEW_ATTRS = ["data-osp-view", "data-slide", "data-page", "data-view", "data-step", "data-index", "name", "aria-label"];
  const VIEW_SCAN_LIMIT = 600;
  const SCROLLER_SCAN_LIMIT = 1500;
  const CONTEXT_LIMIT = 12;
  const TAP_MEMORY_MS = 600000;
  const TRAIL_LIMIT = 6;
  const POPUP_ROLES = /^(dialog|alertdialog|menu|listbox|tooltip)$/;
  const POPUP_CLASS = /(^|[-_])(modal|sheet|bottomsheet|drawer|popup|popover|dialog|dropdown|menu|toast|tooltip|overlay|lightbox|snackbar)([-_]|$)/i;
  const STATE_CLASS = /^(is|has)-|(^|[-_])(open|opened|active|show|shown|showing|visible|in|out|enter|entering|entered|leave|leaving|exit|exiting|hidden|closed|closing|expanded|collapsed|on|off|up|down|animating|animated|transition|transitioning|current|present|past|future|selected)$/i;
  const REVEAL_ATTRS = ["class", "style", "hidden", "open", "inert", "aria-hidden", "aria-expanded", "data-state", "data-open", "data-visible"];
  const REVEAL_DEPTH = 4;
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const textOf = (el) => norm(el.textContent).slice(0, 200);
  const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

  // ---- Documents and frames ----

  const viewOf = (el) => (el.ownerDocument && el.ownerDocument.defaultView) || window;
  const styleOf = (el) => viewOf(el).getComputedStyle(el);
  const topWin = (() => { try { return window.top && window.top.document ? window.top : window; } catch (e) { return window; } })();

  // The <iframe> a document is shown in, or null for the top page (or a
  // frame from another site, which can't be reached).
  function frameOf(doc) {
    try { return doc && doc.defaultView ? doc.defaultView.frameElement : null; } catch (e) { return null; }
  }
  function isCrossOriginFrame(doc) {
    try { return doc.defaultView !== doc.defaultView.top && !doc.defaultView.frameElement; } catch (e) { return true; }
  }
  function frameKeyOf(frame) {
    if (frame.id) return "#" + frame.id;
    const name = frame.getAttribute("name");
    if (name) return "name=" + name;
    const all = Array.from(frame.ownerDocument.getElementsByTagName("iframe"));
    return "iframe:" + all.indexOf(frame) + "/" + all.length;
  }
  function framePath(doc) {
    const path = [];
    for (let frame = frameOf(doc); frame; frame = frameOf(frame.ownerDocument)) path.unshift(frameKeyOf(frame));
    return path;
  }
  function frameByKey(doc, key) {
    const all = Array.from(doc.getElementsByTagName("iframe"));
    if (key[0] === "#") return all.find((f) => f.id === key.slice(1)) || null;
    if (key.startsWith("name=")) return all.find((f) => f.getAttribute("name") === key.slice(5)) || null;
    const m = /^iframe:(\d+)\/(\d+)$/.exec(key);
    return m && all.length === Number(m[2]) ? all[Number(m[1])] || null : null;
  }
  // The frame element and document a path names, from the top page.
  function walkPath(path) {
    let doc = topWin.document;
    let frame = null;
    for (const key of path || []) {
      frame = frameByKey(doc, key);
      if (!frame) return null;
      try { doc = frame.contentDocument; } catch (e) { doc = null; }
      if (!doc) return null;
    }
    return { doc, frame };
  }
  const withoutToken = (search) => search.slice(1).split("&").filter((p) => p && !/^t=[a-z0-9]{24,32}$/i.test(p)).sort();
  // The screen a frame is showing: its own address, which a framed app
  // changes as it moves between screens.
  function frameRoute(doc) {
    const l = doc.defaultView.location;
    const params = withoutToken(l.search);
    return l.pathname + (params.length ? "?" + params.join("&") : "") + l.hash;
  }

  // The part of the top viewport a frame's content shows in.
  function glassOf(frame) {
    const r = topRect(frame);
    const outer = frame.offsetWidth ? r.width / frame.offsetWidth : 1;
    const left = r.left + frame.clientLeft * outer;
    const top = r.top + frame.clientTop * outer;
    const width = frame.clientWidth * outer;
    const height = frame.clientHeight * outer;
    return { left, top, width, height, right: left + width, bottom: top + height, scale: outer };
  }
  // An element's box in the top page's viewport, through any frames.
  function topRect(el) {
    const r = el.getBoundingClientRect();
    const frame = frameOf(el.ownerDocument);
    if (!frame) return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    const g = glassOf(frame);
    const left = g.left + r.left * g.scale;
    const top = g.top + r.top * g.scale;
    return { left, top, width: r.width * g.scale, height: r.height * g.scale, right: left + r.width * g.scale, bottom: top + r.height * g.scale };
  }
  // A point in the top viewport, in a document's own viewport.
  function localPoint(doc, x, y) {
    const frame = frameOf(doc);
    if (!frame) return { x, y };
    // The glass's scale already includes any frames around this one.
    const g = glassOf(frame);
    return { x: (x - g.left) / g.scale, y: (y - g.top) / g.scale };
  }

  // ---- Shown or not ----

  // Our own overlays never count as one of a deck's pages.
  const childElements = (node) =>
    Array.from(node && node.children ? node.children : []).filter((el) => el.id !== "osp-overlay-host");

  function shownSelf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = styleOf(el);
    if (style.display === "none") return false;
    if (style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (style.opacity === "0") return false;
    // display: contents draws no box of its own, but its children do.
    if (style.display === "contents") return true;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // Shown, parents included, and on out through the frame it's in: a
  // device frame that's hidden hides everything on its screen.
  function showing(el) {
    let node = el;
    while (node) {
      for (let at = node; at && at.nodeType === 1; at = at.parentElement) {
        if (!shownSelf(at)) return false;
      }
      node = frameOf(node.ownerDocument);
    }
    return true;
  }

  // What clips an element: ancestors that hide their overflow, the window
  // for something held to it, and the glass of each frame it's in. The
  // document itself isn't a clip: a paragraph below the fold is on the page.
  function clipOf(node) {
    let clip = null;
    const cut = (box) => {
      if (!clip) { clip = { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; return; }
      clip.left = Math.max(clip.left, box.left);
      clip.top = Math.max(clip.top, box.top);
      clip.right = Math.min(clip.right, box.right);
      clip.bottom = Math.min(clip.bottom, box.bottom);
    };
    let el = node;
    while (el) {
      const doc = el.ownerDocument;
      let fixed = styleOf(el).position === "fixed";
      for (let at = el.parentElement; at; at = at.parentElement) {
        if (at === doc.body || at === doc.documentElement) break;
        const style = styleOf(at);
        if (style.position === "fixed") fixed = true;
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          const box = topRect(at);
          if (box.width || box.height) cut(box);
        }
      }
      const frame = frameOf(doc);
      if (frame) {
        cut(glassOf(frame));
        el = frame;
      } else {
        if (fixed) cut({ left: 0, top: 0, right: topWin.innerWidth, bottom: topWin.innerHeight });
        el = null;
      }
    }
    return clip;
  }

  function inSight(el) {
    const clip = clipOf(el);
    if (!clip) return true;
    const box = topRect(el);
    const w = Math.min(box.right, clip.right) - Math.max(box.left, clip.left);
    const h = Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top);
    return w > 1 && h > 1;
  }
  const openNow = (el) => showing(el) && inSight(el);

  // ---- What a pin is on ----

  // FNV-1a, 32 bit, base 36: the same as Vault Publisher's anchor.ts.
  function hashText(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(36);
  }
  const baseOf = (id) => { const cut = id.lastIndexOf("-"); return cut === -1 ? id : id.slice(0, cut); };

  // The elements that scroll their own content: their rows are anchors too.
  function scrollersIn(doc) {
    const out = [];
    const all = doc.body ? doc.body.getElementsByTagName("*") : [];
    let asked = 0;
    for (let i = 0; i < all.length && asked < SCROLLER_SCAN_LIMIT; i++) {
      const el = all[i];
      if (el.children.length < 2 || el.id === "osp-overlay-host") continue;
      asked++;
      const style = styleOf(el);
      if (/^(auto|scroll)$/.test(style.overflowY) || /^(auto|scroll)$/.test(style.overflowX)) out.push(el);
    }
    return out;
  }

  // Every anchorable element in a document, by id. Kept until the document
  // changes, and a couple of seconds at most, for scrollers a style change
  // made. Ids are worked out here, never written into the page.
  function blocksOf(doc) {
    const now = Date.now();
    const cache = doc.__terminusBlocks;
    if (cache && (!cache.dirty || now - cache.at < 300) && now - cache.at < 2000) return cache;
    if (!doc.__terminusObserver && doc.documentElement) {
      try {
        const observer = new doc.defaultView.MutationObserver(() => { if (doc.__terminusBlocks) doc.__terminusBlocks.dirty = true; });
        observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
        doc.__terminusObserver = observer;
      } catch (e) {}
    }
    const byId = new Map();
    const idOf = new Map();
    const seen = new Map();
    const add = (el) => {
      if (idOf.has(el) || el.id === "osp-overlay-host") return;
      const text = norm(el.textContent);
      if (!text) return;
      const base = hashText(el.tagName.toLowerCase() + "\u0000" + text);
      const count = seen.get(base) || 0;
      seen.set(base, count + 1);
      const id = count === 0 ? base : base + "-" + count;
      byId.set(id, el);
      idOf.set(el, id);
    };
    for (const el of doc.querySelectorAll(BLOCK_SELECTOR)) add(el);
    for (const scroller of scrollersIn(doc)) for (const row of scroller.children) add(row);
    const fresh = { byId, idOf, dirty: false, at: now };
    doc.__terminusBlocks = fresh;
    return fresh;
  }
  function nearestBlock(el) {
    const doc = el.ownerDocument;
    const blocks = blocksOf(doc);
    for (let at = el; at && at.nodeType === 1; at = at.parentElement) {
      if (at === doc.body || at === doc.documentElement) break;
      if (blocks.idOf.has(at)) return at;
    }
    return null;
  }
  // The one unclaimed element with a lost id's tag and text; none when
  // there are two, which would be a guess.
  function recovered(doc, id, claimed) {
    const base = baseOf(id);
    let found = null;
    for (const [key, el] of blocksOf(doc).byId) {
      if (baseOf(key) !== base && key !== base) continue;
      if (claimed.has(el)) continue;
      if (found) return null;
      found = el;
    }
    return found;
  }
  function copiesOf(doc, id) {
    const base = baseOf(id);
    let n = 0;
    for (const key of blocksOf(doc).byId.keys()) if (baseOf(key) === base || key === base) n++;
    return n;
  }

  // ---- Screens ----

  // The top page's query and fragment. A fragment that names an element
  // is a place to scroll to, not a screen.
  function currentRoute() {
    const doc = topWin.document;
    const l = topWin.location;
    const params = withoutToken(l.search);
    let hash = l.hash.length > 1 ? l.hash : "";
    if (hash) {
      let id = hash.slice(1);
      try { id = decodeURIComponent(id); } catch (e) {}
      if (doc.getElementById(id) || doc.getElementsByName(id).length) hash = "";
    }
    return (params.length ? "?" + params.join("&") : "") + hash || null;
  }

  function viewKeyOf(el) {
    if (el.id) return "#" + el.id;
    for (const name of VIEW_ATTRS) {
      const value = el.getAttribute(name);
      if (value) return name + "=" + value;
    }
    const kids = childElements(el.parentNode);
    return el.tagName.toLowerCase() + ":" + kids.indexOf(el) + "/" + kids.length;
  }

  // Every run of same-tag siblings with exactly one shown: a deck's pages.
  function deckGroups(doc) {
    if (!doc.body) return [];
    const found = [];
    const queue = [doc.body];
    let seen = 0;
    while (queue.length && seen < VIEW_SCAN_LIMIT) {
      const kids = childElements(queue.shift());
      const groups = new Map();
      const shown = [];
      for (const kid of kids) {
        seen++;
        const up = shownSelf(kid);
        if (up) shown.push(kid);
        if (!groups.has(kid.tagName)) groups.set(kid.tagName, { members: [], shown: [] });
        const group = groups.get(kid.tagName);
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
  const currentViewKey = (doc) => deckGroups(doc).map((g) => viewKeyOf(g.shown)).sort().join(">");

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
  // further up is the app's outer frame, which never closes. Inside: from
  // its parent, or an element with an id would be its own dialog, and read
  // as closed the moment it was rewritten.
  function contextOf(node) {
    const doc = node.ownerDocument;
    let up = 0;
    for (let el = node.parentElement; el && el.nodeType === 1; el = el.parentElement) {
      if (el === doc.body || el === doc.documentElement) break;
      if (++up > CONTEXT_LIMIT) break;
      const key = contextKeyOf(el);
      if (key) return { key, el };
    }
    return null;
  }
  function contextNodes(doc, key) {
    if (!key) return [];
    if (key[0] === "#") {
      const one = doc.getElementById(key.slice(1));
      return one ? [one] : [];
    }
    if (key[0] === "~") {
      const tag = key.slice(1).split(/[.[]/)[0] || "*";
      return Array.from(doc.getElementsByTagName(tag)).filter((el) => popupKeyOf(el) === key);
    }
    const eq = key.indexOf("=");
    if (eq === -1) return [];
    const name = key.slice(0, eq);
    const value = key.slice(eq + 1);
    let found = [];
    try { found = Array.from(doc.querySelectorAll("[" + name + "]")); } catch (e) { return []; }
    return found.filter((el) => el.getAttribute(name) === value);
  }

  // The open element a context key names, for this pin: of several alike
  // (every bottom sheet is a div.sheet), the one holding its element.
  function holderFor(doc, key, target) {
    const open = contextNodes(doc, key).filter(openNow);
    if (target) {
      const holding = open.find((h) => h.contains(target) || target.contains(h));
      if (holding) return holding;
      if (key[0] === "~" && open.length) return null;
    }
    return open[0] || null;
  }

  // On the page of the deck it was left on: the same pages up, the named
  // ones it was left on still showing, or its element showing inside the
  // page that's up (a key can differ over a banner that rotates).
  function onThisView(doc, place, el) {
    if (!place.view) return true;
    if (place.view === currentViewKey(doc)) return true;
    if (place.view.split(">").every((part) => contextNodes(doc, part).some(openNow))) return true;
    return !!el && showing(el) && deckGroups(doc).some((g) => g.shown.contains(el));
  }

  // ---- Names, for the tray ----

  function popupLabel(key) {
    const body = String(key).slice(1);
    const role = /\[role=([^\]]+)\]/.exec(body);
    const bits = body.replace(/\[.*$/, "").split(".");
    for (let i = 1; i < bits.length; i++) {
      const said = POPUP_CLASS.exec(bits[i]);
      if (said) return said[2].toLowerCase();
    }
    if (role) return role[1];
    return bits[1] || bits[0] || "popup";
  }
  function viewLabel(key) {
    return String(key).split(">").map((part) => {
      if (part[0] === "#") return part.slice(1);
      if (part[0] === "~") return popupLabel(part);
      const eq = part.indexOf("=");
      if (eq !== -1) return part.slice(eq + 1);
      const m = /:(\d+)\/(\d+)$/.exec(part);
      return m ? "slide " + (Number(m[1]) + 1) + " of " + m[2] : part;
    }).join(" / ");
  }
  function screenLabel(route) {
    const text = String(route || "");
    const cut = text.search(/[?#]/);
    const path = cut === -1 ? text : text.slice(0, cut);
    const rest = cut === -1 ? "" : text.slice(cut);
    let name = (path.split("/").pop() || "").replace(/\.html?$/i, "");
    if (!name || name === "index") { const dirs = path.split("/").filter(Boolean); name = dirs.length > 1 ? dirs[dirs.length - 2] : ""; }
    return [name, rest].filter(Boolean).join(" ") || "the first screen";
  }

  // ---- Clicks that led somewhere ----

  // Where a document is, as a trail compares it: the page's route at the
  // top; the frame and its screen inside one.
  function placeOf(doc) {
    return frameOf(doc) ? framePath(doc).join(">") + "@" + frameRoute(doc) : String(currentRoute() || "");
  }
  // The recent clicks in this document since its address was last what it
  // is now, oldest first, leaving out those inside the dialog the pin is in
  // (they were on it, not on the way to it).
  function trailTo(doc, holder) {
    const taps = topWin.__terminusTapLog || [];
    const here = placeOf(doc);
    const path = framePath(doc).join(">");
    const now = Date.now();
    const out = [];
    for (let i = taps.length - 1; i >= 0; i--) {
      const tap = taps[i];
      if (tap.path.join(">") !== path) continue;
      if (now - tap.at >= TAP_MEMORY_MS || tap.place !== here) break;
      const el = holder ? blocksOf(doc).byId.get(tap.block) : null;
      if (holder && el && holder.contains(el)) continue;
      out.unshift({ path: tap.path, block: tap.block, text: tap.text });
    }
    return out.slice(-TRAIL_LIMIT);
  }

  function revealStateOf(holder) {
    const out = [];
    let el = holder;
    for (let level = 0; level < REVEAL_DEPTH; level++) {
      if (!el || el.nodeType !== 1 || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) break;
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

  // ---- Finding a pin's element ----

  // The document a pin is in, or why it can't be reached.
  function docFor(place) {
    if (!place || !place.frame) return { doc: topWin.document, frame: null };
    if (place.frame.crossOrigin) return { why: "cross-origin" };
    const found = walkPath(place.frame.path);
    return found ? found : { why: "no-frame" };
  }

  // The picked element by its selector, if that still finds one of the
  // same tag, checked against its text; else the one element with its tag
  // and text; else the selector's, if the tag fits (edited where it stands).
  function bySelector(doc, q) {
    let el = null;
    try { el = doc.querySelector(q.selector); } catch (e) {}
    const text = q.place ? q.place.text : "";
    const fits = !!el && el.tagName.toLowerCase() === q.tag;
    if (fits && (!text || textOf(el) === text)) return { el };
    if (text) {
      const matches = Array.from(doc.getElementsByTagName(q.tag)).filter((m) => textOf(m) === text);
      const pick = matches.length === 1 ? matches : matches.filter(showing);
      if (pick.length === 1) return { el: pick[0] };
    }
    return fits ? { el, adopted: true } : null;
  }

  // The element a pin is on: its block by id; else the one unclaimed block
  // its id renumbered to; else the picked element by its selector, which
  // keeps a pin on an element the agent rewrote where it stands (Vault
  // Publisher reports those as lost; here checking the fix is the point).
  function anchorFor(doc, q, exact, claimed) {
    const place = q.place;
    if (place && place.block) {
      if (exact) return { el: exact };
      const moved = recovered(doc, place.block, claimed);
      if (moved) return { el: moved };
    }
    const found = bySelector(doc, q);
    if (!found) return null;
    return { el: found.el, viaSelector: true, adopted: !!found.adopted };
  }
`;

/**
 * Runs with `this` as the picked element, in its own document's context
 * (a frame's, for an element in a frame), with where the click was in the
 * top page's viewport: the PinPlace to record.
 */
export const PLACE_OF = String.raw`function (x, y) {
  ${HELPERS}
  const picked = this.nodeType === 1 ? this : this.parentElement;
  if (!picked) return null;
  const doc = picked.ownerDocument;
  const block = nearestBlock(picked);
  const on = topRect(block || picked);
  const own = topRect(picked);
  const context = contextOf(picked);
  const place = {
    route: currentRoute(),
    view: currentViewKey(doc),
    context: context ? context.key : null,
    text: textOf(picked),
    block: block ? blocksOf(doc).idOf.get(block) : null,
    rx: clamp01((x - on.left) / on.width),
    ry: clamp01((y - on.top) / on.height),
    erx: clamp01((x - own.left) / own.width),
    ery: clamp01((y - own.top) / own.height),
    frame: null,
    px: x + topWin.scrollX,
    py: y + topWin.scrollY,
    rect: { x: own.left, y: own.top, width: own.width, height: own.height },
    trail: [],
  };
  if (context) {
    place.reveal = revealStateOf(context.el);
    const area = topRect(context.el);
    if (area.width && area.height) {
      place.cx = clamp01((x - area.left) / area.width);
      place.cy = clamp01((y - area.top) / area.height);
    }
  }
  if (isCrossOriginFrame(doc)) {
    place.frame = { crossOrigin: true };
  } else if (frameOf(doc)) {
    place.frame = { path: framePath(doc), route: frameRoute(doc), src: doc.defaultView.location.pathname };
    const glass = glassOf(frameOf(doc));
    place.fx = clamp01((x - glass.left) / glass.width);
    place.fy = clamp01((y - glass.top) / glass.height);
  }
  place.trail = trailTo(doc, context ? context.el : null);
  return place;
}`;

/**
 * Runs in the top page with a list of PinQuery: a PinState for each. In
 * the order of Vault Publisher's `spot`, which says why each step is there.
 */
export const PINS_FOR = String.raw`function (queries) {
  ${HELPERS}
  const docs = queries.map((q) => docFor(q.place));

  // Exact ids first, all of them, so a pin that lost its suffix isn't
  // recovered onto an element another pin holds.
  const claimed = new Map();
  const exact = queries.map((q, i) => {
    const doc = docs[i].doc;
    if (!doc || !q.place || !q.place.block) return null;
    const el = blocksOf(doc).byId.get(q.place.block) || null;
    if (el) {
      if (!claimed.has(doc)) claimed.set(doc, new Set());
      claimed.get(doc).add(el);
    }
    return el;
  });

  return queries.map((q, i) => {
    const place = q.place;
    const d = docs[i];
    if (!d.doc) return { state: "missing", why: d.why };
    const doc = d.doc;

    // Another screen of the page, or of the device's.
    if (place) {
      if ((place.route || null) !== currentRoute()) return { state: "elsewhere", kind: "screen", where: screenLabel(place.route) };
      if (d.frame) {
        if (!showing(d.frame)) return { state: "elsewhere" };
        if (place.frame.route && frameRoute(doc) !== place.frame.route) return { state: "elsewhere", kind: "screen", where: screenLabel(place.frame.route) };
      }
    }

    const found = anchorFor(doc, q, exact[i], claimed.get(doc) || new Set());
    let target = found ? found.el : null;

    // Inside something that isn't open: a dismissed dialog, a sheet slid
    // shut, a menu that closed. There's nowhere honest to draw it.
    let holder = null;
    if (place && place.context) {
      holder = holderFor(doc, place.context, target);
      if (!holder) return { state: "elsewhere", kind: "closed", where: viewLabel(place.context) };
    }

    // On another slide of the deck, or inside something collapsed.
    if (target && !showing(target)) return place && place.view ? { state: "elsewhere", kind: "view", where: viewLabel(place.view) } : { state: "elsewhere" };
    if (place && !onThisView(doc, place, target)) return { state: "elsewhere", kind: "view", where: viewLabel(place.view) };

    // A pin on a popover's text, anchored to the section the popover sits
    // in: the popover is nearer, and its box is what the pin moves with.
    if (target && holder && holder !== target && target.contains(holder) && place.cx !== undefined) target = null;

    if (target) {
      const box = topRect(target);
      if (box.width === 0 && box.height === 0) return { state: "elsewhere" };
      const own = found.viaSelector;
      const rx = place ? (own ? place.erx : place.rx) : undefined;
      const ry = place ? (own ? place.ery : place.ry) : undefined;
      const x = box.left + (rx === undefined ? 1 : rx) * box.width;
      const y = box.top + (ry === undefined ? 0 : ry) * box.height;
      const shown = { state: "shown", x, y, rect: { x: box.left, y: box.top, width: box.width, height: box.height }, clip: clipOf(target) };
      if (found.adopted && doc.readyState === "complete") shown.text = textOf(target);
      return shown;
    }

    // Its element is gone. Why, for the tray: the text is there twice now;
    // it's in a sheet like this one but maybe another; or it's rewritten.
    const why = place && place.block && copiesOf(doc, place.block) > 1 ? "duplicate"
      : place && place.context && place.context[0] === "~" ? "other-sheet" : "rewritten";
    if (!place) return { state: "missing", why };

    // On an app, text changes for reasons nobody edited, so the pin stays
    // where it was dropped: on its dialog, on the device's glass, on the page.
    if (holder && place.cx !== undefined) {
      const area = topRect(holder);
      return { state: "shown", x: area.left + place.cx * area.width, y: area.top + place.cy * area.height, rect: null, clip: clipOf(holder), lost: why };
    }
    if (d.frame && place.fx !== undefined) {
      const glass = glassOf(d.frame);
      return { state: "shown", x: glass.left + place.fx * glass.width, y: glass.top + place.fy * glass.height, rect: null, clip: glass, lost: why };
    }
    if (!d.frame && place.px !== undefined) {
      return { state: "shown", x: place.px - topWin.scrollX, y: place.py - topWin.scrollY, rect: null, clip: null, lost: why };
    }
    return { state: "missing", why };
  });
}`;

/**
 * Runs in the top page with one PinQuery: takes the user to its element,
 * wherever it is (see GoResult):
 *
 *   - On another screen of the top page: says so, and the caller goes.
 *   - In a frame showing another screen: sends the frame there.
 *   - On another page of a deck: turns the deck to it, by swapping the
 *     attributes that make one page shown and the others hidden between
 *     the page that's up and the one wanted. The deck has no method to
 *     call, and this is the change it makes itself, so its Prev and Next
 *     still work afterwards (its own counter catches up on the next turn).
 *   - In a dialog or sheet that has closed but is still in the page: puts
 *     back the attributes that had it open, undone when the next note is
 *     shown, where the page hasn't changed them since.
 *   - Reached only by clicks: says how many, for the user to choose.
 *   - Then scrolls it into view.
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

  const last = topWin.__terminusPeek;
  topWin.__terminusPeek = null;
  if (last) {
    for (const change of last.slice().reverse()) {
      if (!change.el.isConnected || change.el.getAttribute(change.name) !== change.after) continue;
      if (change.before === null) change.el.removeAttribute(change.name); else change.el.setAttribute(change.name, change.before);
    }
  }

  const place = q.place;
  if (place && (place.route || null) !== currentRoute()) return { result: "route" };
  const d = docFor(place);
  if (!d.doc) return { result: "missing" };
  const doc = d.doc;
  if (d.frame && place.frame.route && frameRoute(doc) !== place.frame.route) {
    try { d.frame.contentWindow.location.href = new URL(place.frame.route, doc.defaultView.location.href).href; } catch (e) { return { result: "missing" }; }
    return { result: "frame" };
  }

  // Turn the deck, a level at a time: an inner deck is only found once the
  // outer one is on the right page.
  if (place && place.view) {
    const wanted = place.view.split(">");
    for (let round = 0; round < 4; round++) {
      if (currentViewKey(doc) === place.view) break;
      let moved = false;
      for (const group of deckGroups(doc)) {
        if (wanted.includes(viewKeyOf(group.shown))) continue;
        const member = group.members.find((m) => m !== group.shown && wanted.includes(viewKeyOf(m)));
        if (member) { swap(group.shown, member); moved = true; }
      }
      if (!moved) break;
    }
  }

  const find = () => anchorFor(doc, q, place && place.block ? blocksOf(doc).byId.get(place.block) || null : null, new Set());
  let found = find();

  // Open the dialog it was left in, if that has closed but is still there.
  if (place && place.context && place.reveal && place.reveal.length && !(found && openNow(found.el))) {
    const holders = contextNodes(doc, place.context);
    const holder = (found && holders.find((h) => h.contains(found.el))) || holders[0];
    if (holder) {
      const changes = [];
      let at = holder;
      for (const saved of place.reveal) {
        if (!at || at.nodeType !== 1 || at === doc.body) break;
        for (const name of REVEAL_ATTRS) {
          const want = Object.prototype.hasOwnProperty.call(saved, name) ? saved[name] : null;
          const have = at.getAttribute(name);
          if (want === have) continue;
          changes.push({ el: at, name, before: have, after: want });
          if (want === null) at.removeAttribute(name); else at.setAttribute(name, want);
        }
        at = at.parentElement;
      }
      if (changes.length) topWin.__terminusPeek = changes;
      found = find();
    }
  }

  const there = !!found && openNow(found.el);
  if (!there && place && place.trail && place.trail.length) return { result: "trail", steps: place.trail.length };
  if (!found) return { result: "missing" };
  if (d.frame) d.frame.scrollIntoView({ block: "nearest", inline: "nearest" });
  found.el.scrollIntoView({ block: "center", inline: "center" });
  return { result: openNow(found.el) ? "shown" : "hidden" };
}`;

/**
 * Runs in the top page with one TrailStep: clicks the element it names,
 * as the user did. False when it isn't there.
 */
export const REPLAY_STEP = String.raw`function (step) {
  ${HELPERS}
  const found = walkPath(step.path);
  if (!found) return false;
  const blocks = blocksOf(found.doc);
  let el = blocks.byId.get(step.block) || null;
  if (!el) {
    const base = baseOf(step.block);
    const alike = Array.from(blocks.byId).filter(([key]) => baseOf(key) === base).map(([, e]) => e);
    if (alike.length === 1) el = alike[0];
  }
  if (!el) return false;
  el.click();
  return true;
}`;

/**
 * Evaluated in the top page on every load: remembers the last few clicks,
 * in it and in its frames, as the element they landed on, so a pin left
 * on a screen only clicks reach can offer to retrace them. Kept in the
 * page, and gone with it.
 */
export const TAP_RECORDER = String.raw`(() => {
  ${HELPERS}
  if (window.__terminusTapTimer) return;
  const hook = (doc) => {
    if (!doc || doc.__terminusTaps) return;
    doc.__terminusTaps = true;
    // Captured on pointerdown, before the click has had any effect, so
    // the address it's recorded at is the one it was made at.
    doc.addEventListener("pointerdown", (event) => {
      const t = event.target;
      if (!t || t.nodeType !== 1) return;
      const block = nearestBlock(t);
      if (!block) return;
      const taps = topWin.__terminusTapLog || (topWin.__terminusTapLog = []);
      taps.push({ path: framePath(doc), block: blocksOf(doc).idOf.get(block), text: textOf(block).slice(0, 120), place: placeOf(doc), at: Date.now() });
      if (taps.length > 16) taps.shift();
    }, true);
  };
  const hookFrames = (doc) => {
    for (const frame of doc.getElementsByTagName("iframe")) {
      let inner = null;
      try { inner = frame.contentDocument; } catch (e) {}
      if (inner) { hook(inner); hookFrames(inner); }
    }
  };
  hook(document);
  hookFrames(document);
  window.__terminusTapTimer = setInterval(() => hookFrames(document), 1000);
})()`;

/**
 * Runs with `this` as the element the browser's hit test found at (x, y),
 * in the top page's viewport: that element when it's showing, else the
 * first showing element at that point. The hit test counts elements that
 * can't be seen, such as a deck's faded-out slides stacked over the one
 * that's up.
 */
export const SHOWN_AT = String.raw`function (x, y) {
  ${HELPERS}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el && showing(el)) return el;
  const doc = el ? el.ownerDocument : document;
  const local = localPoint(doc, x, y);
  for (const candidate of doc.elementsFromPoint(local.x, local.y)) {
    if (showing(candidate)) return candidate;
  }
  return el;
}`;

/**
 * Runs in the top page with a list of PinQuery: how each picked element
 * looks (see Fingerprint in review.ts), or null when it isn't on the page.
 * Found as pins are, frames included.
 */
export const FINGERPRINTS_FOR = String.raw`function (queries) {
  ${HELPERS}
  const STYLES = ["color", "background-color", "background-image", "font-family", "font-size", "font-weight", "font-style",
    "text-decoration-line", "text-transform", "text-align", "letter-spacing", "display", "visibility", "opacity",
    "border-top-width", "border-top-style", "border-top-color", "border-radius", "box-shadow"];
  const ATTRS = ["class", "src", "href", "alt", "title", "aria-label", "placeholder", "type", "disabled"];
  return queries.map((q) => {
    const d = docFor(q.place);
    if (!d.doc) return null;
    const found = bySelector(d.doc, q);
    if (!found) return null;
    const el = found.el;
    const cs = styleOf(el);
    const styles = {};
    for (const name of STYLES) styles[name] = cs.getPropertyValue(name);
    const attrs = {};
    for (const name of ATTRS) { const v = el.getAttribute(name); if (v !== null) attrs[name] = v.slice(0, 300); }
    return { text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500), attrs, styles, viewport: viewOf(el).innerWidth };
  });
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

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function isPinState(value: unknown): value is PinState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.state === "elsewhere") return true;
  if (s.state === "missing") return typeof s.why === "string";
  return s.state === "shown" && finite(s.x) && finite(s.y);
}

export function isGoResult(value: unknown): value is GoResult {
  if (typeof value !== "object" || value === null) return false;
  const r = (value as Record<string, unknown>).result;
  return r === "shown" || r === "hidden" || r === "missing" || r === "route" || r === "frame" || r === "trail";
}

/** What the tray says about a pin whose element couldn't be found. */
export const LOST_REASONS: Record<LostReason, string> = {
  duplicate: "Lost its place: this text is now on the page more than once, so it can't tell which.",
  rewritten: "Lost its place: what it was on has changed or moved.",
  "other-sheet": "Lost its place: it isn't in the one showing now. It may be in a different one, or changed since.",
  "cross-origin": "In a frame from another site, which the browser can't look inside.",
  "no-frame": "In a frame that isn't on the page now.",
};

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
