/**
 * Review notes: what the user says about elements of a page in the Terminus
 * browser, and the conversation with the agent about each one.
 *
 * They aren't a one-way paste that's gone once sent: they stay pinned on the
 * page, and each one closes its own loop:
 *
 *   open --send--> sent --agent replies--> answered (a question answered)
 *                                      \-> fixed (a change for the user to check)
 *   fixed --user accepts--> resolved
 *   any --user follows up--> open again, with the thread kept
 *
 * Kept in memory for the Obsidian session, keyed by page, so closing and
 * reopening a browser on the same page brings its pins back. Nothing is
 * written to the vault. Nothing here needs Obsidian, so it can be tested on
 * its own.
 */

import type { PinPlace } from "./pinPlace";

/** What the user wants done about an element: see INTENT_HINTS. */
export type ReviewIntent = "change" | "question" | "keep";
export type ReviewStatus = "open" | "sent" | "answered" | "fixed" | "resolved";

export const INTENT_LABELS: Record<ReviewIntent, string> = {
  change: "Change",
  question: "Question",
  keep: "Keep",
};

/** What each type means, for the user (a tooltip). */
export const INTENT_HINTS: Record<ReviewIntent, string> = {
  change: "Ask the agent to change this. It edits the page, then you check the result.",
  question: "Ask about this without asking for a change. The agent answers and leaves the page as it is.",
  keep: "Mark this as right as it is. The agent won't change it while it works on your other comments.",
};

/** What each type means, for the agent (in the message it gets). */
const INTENT_FOR_AGENT: Record<ReviewIntent, string> = {
  change: "Change",
  question: "Question -- answer it, don't change the page for it",
  keep: "Keep -- leave this element as it is",
};

export const STATUS_LABELS: Record<ReviewStatus, string> = {
  open: "Not sent",
  sent: "With the agent",
  answered: "Answered",
  fixed: "Check the fix",
  resolved: "Done",
};

/** What was picked on the page, as the page described it. */
export interface PickedElement {
  /** A CSS selector that found exactly this element when it was picked. */
  selector: string;
  /** `button`, `img`, ... */
  tag: string;
  role: string;
  /** Its accessible name, or the start of its text. */
  name: string;
  /** The start of its visible text. */
  text: string;
  /** Its opening tag and a little of what's inside, for the agent to search for. */
  html: string;
}

/**
 * How a kept element looked: its text, a few attributes and the computed
 * styles a person would notice. Not its size or position, which change
 * whenever the pane is resized, so a Keep doesn't cry wolf over that.
 */
export interface Fingerprint {
  text: string;
  attrs: Record<string, string>;
  styles: Record<string, string>;
  /** The page's width when it was read: fluid type scales with it. */
  viewport?: number;
}

/** Styles in lengths, which a fluid layout changes with the page's width. */
const WIDTH_DEPENDENT_STYLES = new Set(["font-size", "letter-spacing", "border-top-width", "border-radius", "box-shadow"]);

/** A kept element that no longer looks the way it did when it was kept. */
export interface KeepDrift {
  /** What changed, one line each: `text: "accounts" → "Accounts"`. */
  changes: string[];
  /** How it looks now, to accept as the new baseline. Null when it's gone. */
  current: Fingerprint | null;
  at: number;
}

export interface ThreadEntry {
  by: "user" | "agent";
  /** Who, for an agent: its terminal's name. */
  who?: string;
  text: string;
  at: number;
}

export interface ReviewNote {
  /** `n1`, `n2`, ... unique for the Obsidian session. */
  id: string;
  /** Which page it belongs to (see pageKey in AgentBrowser). */
  pageKey: string;
  /** The page as the user saw it, for the message to the agent. */
  pageUrl: string;
  /** Its address without the query, to go back to it. */
  href: string;
  pageTitle: string;
  /** The file behind the page, when Terminus knows it. */
  sourcePath: string | null;
  element: PickedElement;
  intent: ReviewIntent;
  status: ReviewStatus;
  thread: ThreadEntry[];
  /** A PNG of the element as it looked when picked, if one could be taken. */
  screenshotPath: string | null;
  /** The terminal (hook token) it was last sent to. */
  sentTo: string | null;
  /** Where on the element the user clicked, as fractions across and down
   *  it, so its pin stays on that spot as the page moves. */
  anchor: { rx: number; ry: number } | null;
  /** Which slide or screen of the page it was left on, so its pin shows
   *  only there (see pinPlace.ts). Null when the page didn't say. */
  place: PinPlace | null;
  /** Keep only: how the element looked when kept, to notice a change. */
  baseline: Fingerprint | null;
  /** Keep only: set while the element doesn't match its baseline. */
  drift: KeepDrift | null;
  createdAt: number;
  updatedAt: number;
}

export const MAX_NOTE_LENGTH = 4000;
export const MAX_NOTES = 500;

/** The session's review notes, for every page. */
export class ReviewBook {
  private notes = new Map<string, ReviewNote>();
  private nextId = 1;
  private listeners = new Set<(note: ReviewNote | null) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  add(input: {
    pageKey: string;
    pageUrl: string;
    href: string;
    pageTitle: string;
    sourcePath: string | null;
    element: PickedElement;
    intent: ReviewIntent;
    text: string;
    screenshotPath: string | null;
    baseline?: Fingerprint | null;
    anchor?: { rx: number; ry: number } | null;
    place?: PinPlace | null;
  }): ReviewNote {
    const text = cleanText(input.text);
    // A Keep says enough on its own; anything else needs words.
    if (!text && input.intent !== "keep") throw new Error("A comment needs some text");
    if (this.notes.size >= MAX_NOTES) throw new Error(`There are already ${MAX_NOTES} review notes; clear some first`);
    const at = this.now();
    const note: ReviewNote = {
      id: `n${this.nextId++}`,
      pageKey: input.pageKey,
      pageUrl: input.pageUrl,
      href: input.href,
      pageTitle: input.pageTitle,
      sourcePath: input.sourcePath,
      element: input.element,
      intent: input.intent,
      status: "open",
      thread: text ? [{ by: "user", text, at }] : [],
      screenshotPath: input.screenshotPath,
      sentTo: null,
      anchor: input.anchor ?? null,
      place: input.place ?? null,
      baseline: input.intent === "keep" ? (input.baseline ?? null) : null,
      drift: null,
      createdAt: at,
      updatedAt: at,
    };
    this.notes.set(note.id, note);
    this.emit(note);
    return note;
  }

  get(id: string): ReviewNote | undefined {
    return this.notes.get(id);
  }

  /** Notes on one page, oldest first. */
  forPage(pageKey: string): ReviewNote[] {
    return this.all().filter((note) => note.pageKey === pageKey);
  }

  all(): ReviewNote[] {
    return [...this.notes.values()].sort((a, b) => a.createdAt - b.createdAt || idNumber(a.id) - idNumber(b.id));
  }

  /** Changes what the user wrote, while it hasn't been sent. */
  edit(id: string, text: string, intent: ReviewIntent): ReviewNote {
    const note = this.require(id);
    const clean = cleanText(text);
    if (!clean && intent !== "keep") throw new Error("A comment needs some text");
    if (note.status !== "open") throw new Error("Only a comment that hasn't been sent can be edited");
    const last = note.thread[note.thread.length - 1];
    if (last && last.by !== "user") throw new Error("Only a comment that hasn't been sent can be edited");
    if (last && clean) last.text = clean;
    else if (last) note.thread.pop();
    else if (clean) note.thread.push({ by: "user", text: clean, at: this.now() });
    note.intent = intent;
    return this.touch(note);
  }

  remove(id: string): void {
    if (this.notes.delete(id)) this.emit(null);
  }

  /** Removes the notes on a page that are done, or all of them. */
  clear(pageKey: string, onlyResolved: boolean): number {
    let removed = 0;
    for (const note of this.forPage(pageKey)) {
      if (onlyResolved && note.status !== "resolved") continue;
      this.notes.delete(note.id);
      removed++;
    }
    if (removed) this.emit(null);
    return removed;
  }

  /**
   * The text a pin's element has now, when it was edited where it stands,
   * so the pin finds it straight away next time. Not a change anyone needs
   * telling about, so nothing listening hears of it.
   */
  retext(id: string, text: string): void {
    const note = this.notes.get(id);
    if (note?.place) note.place = { ...note.place, text };
  }

  /** After the user sends notes to an agent. */
  markSent(ids: string[], token: string): void {
    for (const id of ids) {
      const note = this.notes.get(id);
      if (!note || note.status !== "open") continue;
      note.status = "sent";
      note.sentTo = token;
      this.touch(note);
    }
  }

  /** The agent's answer: `fixed` when it changed something for the user to check. */
  reply(id: string, text: string, who: string, fixed: boolean): ReviewNote {
    const note = this.require(id);
    if (note.intent === "keep") throw new Error(`${id} is a Keep: it asks you to leave the element alone, so there's nothing to answer`);
    const clean = cleanText(text);
    if (!clean) throw new Error("A reply needs some text");
    if (note.status === "resolved") throw new Error(`${id} is already done`);
    note.thread.push({ by: "agent", who, text: clean, at: this.now() });
    note.status = fixed ? "fixed" : "answered";
    return this.touch(note);
  }

  /**
   * The result of comparing a kept element with its baseline: `current` is
   * how it looks now, or null when it's gone from the page. Returns true
   * when this is a new change, worth telling the user about.
   */
  checkKeep(id: string, current: Fingerprint | null): boolean {
    const note = this.notes.get(id);
    if (!note || note.intent !== "keep" || !note.baseline) return false;
    const changes = current ? diffFingerprints(note.baseline, current) : ["the element is gone from the page"];
    if (changes.length === 0) {
      if (note.drift) {
        note.drift = null;
        this.touch(note);
      }
      return false;
    }
    const isNew = !note.drift || note.drift.changes.join("\n") !== changes.join("\n");
    if (isNew) {
      note.drift = { changes, current, at: this.now() };
      this.touch(note);
    }
    return isNew;
  }

  /** The user is fine with how a kept element looks now: that's the new
   *  baseline. Accepting that it's gone removes the Keep. */
  acceptDrift(id: string): void {
    const note = this.require(id);
    if (!note.drift) return;
    if (!note.drift.current) {
      this.remove(id);
      return;
    }
    // Merged, so values skipped at another width keep their original.
    note.baseline = { ...note.drift.current, styles: { ...note.baseline?.styles, ...note.drift.current.styles } };
    note.drift = null;
    this.touch(note);
  }

  /** A kept element changed: back to open, so the next send asks the agent
   *  to put it back (the message says what changed). */
  requestRestore(id: string): void {
    const note = this.require(id);
    note.status = "open";
    this.touch(note);
  }

  /** The user is happy with it. */
  resolve(id: string): ReviewNote {
    const note = this.require(id);
    note.status = "resolved";
    return this.touch(note);
  }

  /** The user isn't: back to open with what they said added, to send again. */
  followUp(id: string, text: string): ReviewNote {
    const note = this.require(id);
    const clean = cleanText(text);
    if (!clean) throw new Error("A follow-up needs some text");
    note.thread.push({ by: "user", text: clean, at: this.now() });
    note.status = "open";
    return this.touch(note);
  }

  onChange(listener: (note: ReviewNote | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private require(id: string): ReviewNote {
    const note = this.notes.get(id);
    if (!note) throw new Error(`No review note ${id}`);
    return note;
  }

  private touch(note: ReviewNote): ReviewNote {
    note.updatedAt = this.now();
    this.emit(note);
    return note;
  }

  private emit(note: ReviewNote | null): void {
    for (const listener of this.listeners) {
      try {
        listener(note);
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

const MAX_DIFF_VALUE = 80;

/** What differs between two looks of an element, one line per difference. */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const changes: string[] = [];
  const show = (value: string | undefined): string => (value === undefined || value === "" ? "(none)" : `"${inline(value, MAX_DIFF_VALUE)}"`);
  if (before.text !== after.text) changes.push(`text: ${show(before.text)} → ${show(after.text)}`);
  // At another page width, sizes may differ only because the layout is
  // fluid; text, colours and attributes still count.
  const sameWidth = before.viewport === undefined || after.viewport === undefined || Math.abs(before.viewport - after.viewport) <= 2;
  const pairs: [Record<string, string>, Record<string, string>, boolean][] = [
    [before.attrs, after.attrs, false],
    [before.styles, after.styles, !sameWidth],
  ];
  for (const [a, b, skipLengths] of pairs) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (skipLengths && WIDTH_DEPENDENT_STYLES.has(key)) continue;
      if (a[key] !== b[key]) changes.push(`${key}: ${show(a[key])} → ${show(b[key])}`);
    }
  }
  return changes;
}

/**
 * The site a page key belongs to: its served folder, its plugin site, or
 * its origin. Notes on one site travel together.
 */
export function siteOfPageKey(key: string): string {
  if (key.startsWith("file:")) return key.slice(0, key.lastIndexOf("/"));
  const site = key.match(/^site:[^:]+:/);
  if (site) return site[0];
  const origin = key.match(/^[a-z]+:\/\/[^/]+/i);
  return origin ? origin[0] : key;
}

function idNumber(id: string): number {
  return Number(id.slice(1)) || 0;
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_NOTE_LENGTH);
}

/** Text from the page, on one line and bounded: it's the page's, not ours. */
export function inline(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Code in Markdown, fenced so backticks in the page's text can't end it early. */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** How an element reads in a note: `button "Create account"`. */
export function elementLabel(element: PickedElement): string {
  const name = element.name || element.text;
  return name ? `${element.tag} "${inline(name, 60)}"` : element.tag;
}

export interface PromptOptions {
  /** The browser's id for the agent (`b2`), when it can reach the browser. */
  browserId: string | null;
  /** How the agent replies: set when agents may use the Terminus CLI's browser commands. */
  canReply: boolean;
  /** A path as the agent should see it (relative to the vault, say). */
  showPath: (path: string) => string;
  /** Keeps sent before, repeated so they still hold while the agent works
   *  on the new notes. */
  standingKeeps?: ReviewNote[];
}

/**
 * The message that takes open notes to an agent: grouped by page, each with
 * what it's about and where, and how to answer when the agent can.
 */
export function composeReviewPrompt(notes: ReviewNote[], options: PromptOptions): string {
  if (notes.length === 0) return "";
  const pages = new Map<string, ReviewNote[]>();
  for (const note of notes) {
    const list = pages.get(note.pageKey) ?? [];
    list.push(note);
    pages.set(note.pageKey, list);
  }
  const where = options.browserId ? ` in the Terminus browser ${options.browserId}` : " in the Terminus browser";
  const count = notes.length === 1 ? "a review note" : `${notes.length} review notes`;
  const lines: string[] = [`I left ${count} on a page${where}. Please work through ${notes.length === 1 ? "it" : "them"}.`, ""];

  for (const [, list] of pages) {
    const first = list[0]!;
    lines.push(`## ${first.pageTitle ? `${inline(first.pageTitle, 80)} -- ` : ""}${first.pageUrl}`);
    if (first.sourcePath) lines.push(`File: ${inlineCode(options.showPath(first.sourcePath))}`);
    lines.push("");
    for (const note of list) {
      const { element } = note;
      lines.push(`### ${note.id} · ${INTENT_FOR_AGENT[note.intent]} · ${elementLabel(element)}`);
      if (note.sourcePath && note.sourcePath !== first.sourcePath) lines.push(`File: ${inlineCode(options.showPath(note.sourcePath))}`);
      lines.push(`Selector: ${inlineCode(element.selector)}`);
      // The selector is the frame's document's, not the page's.
      const frame = note.place?.frame;
      if (frame && "path" in frame) lines.push(`In a frame showing: ${inlineCode(frame.src)}`);
      if (element.html) lines.push(`Element: ${inlineCode(inline(element.html, 240))}`);
      if (note.screenshotPath) lines.push(`Screenshot (Read it to see the element): ${inlineCode(note.screenshotPath)}`);
      const previous = note.thread.slice(0, -1);
      if (previous.length) {
        lines.push("Earlier:");
        for (const entry of previous) lines.push(`> ${entry.by === "user" ? "Me" : entry.who || "Agent"}: ${inline(entry.text, 600)}`);
      }
      const latest = note.thread[note.thread.length - 1];
      if (latest) lines.push(`${previous.length ? "Now" : "Note"}: ${latest.text}`);
      if (note.drift) lines.push(`It changed, and shouldn't have: ${note.drift.changes.join("; ")}. Put it back as it was.`);
      lines.push("");
    }
  }

  const standing = (options.standingKeeps ?? []).filter((note) => !notes.includes(note));
  if (standing.length) {
    lines.push("## Still keep, from before", "");
    for (const note of standing) {
      lines.push(`- ${note.id} · ${elementLabel(note.element)} on ${note.pageUrl} -- selector ${inlineCode(note.element.selector)}`);
    }
    lines.push("");
  }
  const answerable = notes.filter((note) => note.intent !== "keep");
  if (notes.some((note) => note.intent === "keep") || standing.length) {
    lines.push("Keep notes need no answer: don't change those elements, and check they still look the same after your other changes.");
  }
  if (answerable.length && options.canReply && options.browserId) {
    const id = options.browserId;
    const example = answerable[0]!.id;
    lines.push(
      "Answer each Change and Question note in the browser, where I'm reviewing, as you finish it:",
      "```bash",
      `"$TERMINUS_CLI" browser reply ${id} ${example} "What you changed" --fixed   # --fixed: a change for me to check`,
      `"$TERMINUS_CLI" browser reply ${id} ${example} "Your answer"                # no --fixed: an answer, no change`,
      "```",
      `Check your work in the same browser first (\`browser reload ${id}\`, \`browser snapshot ${id}\`, \`browser screenshot ${id}\`). \`browser notes ${id}\` lists the notes again.`
    );
  } else if (answerable.length) {
    lines.push("Reply with what you did for each Change and Question note, by its id.");
  }
  return lines.join("\n").trimEnd();
}
