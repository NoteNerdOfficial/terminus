import type { ConsoleLevel, DebuggerSession, GuestPage } from "terminus-node-bridge";
import { parseKey } from "./keys";
import { formatSnapshot, parseAxTree, type Snapshot } from "./snapshot";

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  /** Where it came from: the file and line. */
  source: string;
  at: number;
}

export interface PageSummary {
  url: string;
  title: string;
}

/** An error the driver reports to the agent, with a code it can act on. */
export class DriverError extends Error {
  constructor(
    readonly code: "stale_ref" | "not_actionable" | "hidden" | "page_error" | "timeout",
    message: string
  ) {
    super(message);
  }
}

const MAX_CONSOLE = 300;
const SETTLE_MS = 150;
const LOAD_WAIT_MS = 8000;
const POLL_MS = 100;
const SCREENSHOT_TIMEOUT_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Something an agent just did, for the view to show. `point` is where a
 *  click landed, in the page's CSS pixels. */
export interface BrowserActivity {
  verb: string;
  target: string;
  point?: { x: number; y: number };
}

/** Runs a pointer action and then gives keyboard focus back to whatever
 *  had it in Obsidian (see AgentBrowserView). */
export type FocusGuard = (action: () => Promise<void>) => Promise<void>;

/**
 * Drives one agent browser page, the way Playwright does: refs from the
 * last snapshot name elements, and clicks, keys and text are real input
 * events (the page sees them as the user's).
 *
 * Reading and clicking go through Chrome's debugging protocol. Keys and
 * text don't: inside Obsidian its keyboard input lands in whatever has
 * focus in the window -- the agent's own terminal, a note -- not the page.
 * Electron's sendInputEvent and insertText reach the page itself. A click
 * does pull focus into the page, so the focus guard hands it back.
 *
 * Refs last until the page navigates; a ref from before that is refused
 * rather than guessed at.
 */
export class BrowserDriver {
  private page: GuestPage | null = null;
  private debugger: DebuggerSession | null = null;
  private refs = new Map<string, number>();
  private labels = new Map<string, string>();
  /** Console errors since the page last loaded. */
  errorCount = 0;
  /** Told about each action as it happens. */
  onActivity: ((activity: BrowserActivity) => void) | null = null;
  /** Told about each error the page logs to its console. */
  onConsoleError: ((message: string) => void) | null = null;
  private console: ConsoleEntry[] = [];
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly focusGuard: FocusGuard = (action) => action()) {}

  /** From the view once its page is attached. */
  attach(page: GuestPage): void {
    this.page = page;
    this.unsubscribers.push(
      page.onConsoleMessage((message) => {
        if (message.level === "error") {
          this.errorCount++;
          try {
            this.onConsoleError?.(message.message);
          } catch {
            // The view's display never stops the agent.
          }
        }
        this.console.push({ level: message.level, text: message.message, source: message.source ? `${message.source}:${message.line}` : "", at: Date.now() });
        if (this.console.length > MAX_CONSOLE) this.console.splice(0, this.console.length - MAX_CONSOLE);
      })
    );
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    try {
      this.debugger?.detach();
    } catch {
      // The page may already be gone.
    }
    this.debugger = null;
    this.page = null;
  }

  summary(): PageSummary {
    const page = this.requirePage();
    return { url: page.getURL(), title: page.getTitle() };
  }

  // ---- Reading ----

  async snapshot(): Promise<Snapshot> {
    const snapshot = formatSnapshot(parseAxTree(await this.send("Accessibility.getFullAXTree")));
    this.refs = snapshot.refs;
    this.labels = snapshot.labels;
    this.emit("Read", "the page");
    return snapshot;
  }

  /** Console messages since the last call, oldest first. */
  takeConsole(levels: ConsoleLevel[] | null): ConsoleEntry[] {
    const taken = levels ? this.console.filter((entry) => levels.includes(entry.level)) : this.console.slice();
    this.console = [];
    return taken;
  }

  async bodyText(): Promise<string> {
    const value = await this.evaluate("document.body ? document.body.innerText : ''");
    return typeof value === "string" ? value : "";
  }

  async screenshot(shown: boolean): Promise<Uint8Array> {
    if (!shown) throw new DriverError("hidden", "The browser is behind another tab, so it can't be captured. Ask the user to bring it into view.");
    try {
      const png = await this.requirePage().capturePng(SCREENSHOT_TIMEOUT_MS);
      this.emit("Took", "a screenshot");
      return png;
    } catch (err) {
      throw new DriverError("hidden", `Couldn't capture the page: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Acting ----

  async click(ref: string, double: boolean): Promise<void> {
    const point = await this.actionPoint(ref);
    this.emit(double ? "Double-clicked" : "Clicked", this.label(ref), point);
    const base = { x: point.x, y: point.y, button: "left" };
    await this.focusGuard(async () => {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      for (const clickCount of double ? [1, 2] : [1]) {
        await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount });
        await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount });
      }
    });
    await this.settle();
  }

  /** Replaces the field's text (or adds to it with `append`), then presses Enter with `submit`. */
  async type(ref: string, text: string, append: boolean, submit: boolean): Promise<void> {
    const backendNodeId = this.backendNode(ref);
    const objectId = await this.resolve(backendNodeId, ref);
    await this.callOn(
      objectId,
      `function (append) {
        if (this.disabled) throw new Error("it's disabled");
        if (this.readOnly) throw new Error("it's read-only");
        const editable = this.isContentEditable || "value" in this;
        if (!editable) throw new Error("it isn't a text field");
        this.focus();
        if (append) {
          if (typeof this.setSelectionRange === "function" && typeof this.value === "string") {
            try { this.setSelectionRange(this.value.length, this.value.length); } catch (e) {}
          }
          return;
        }
        if (typeof this.select === "function") { this.select(); return; }
        const range = document.createRange();
        range.selectNodeContents(this);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }`,
      [append],
      ref
    );
    this.emit(append ? "Added to" : "Typed into", this.label(ref), await this.centerOf(backendNodeId));
    if (text) await this.requirePage().insertText(text);
    else if (!append) await this.pressKey("Delete");
    if (submit) await this.pressKey("Enter");
    await this.settle();
  }

  /** Presses a key, on an element (focused first) or wherever focus is. */
  async press(key: string, ref: string | null): Promise<void> {
    // Checked before focusing anything, so a typo changes nothing.
    try {
      parseKey(key);
    } catch (err) {
      throw new DriverError("not_actionable", err instanceof Error ? err.message : String(err));
    }
    if (ref) {
      const backendNodeId = this.backendNode(ref);
      await this.resolve(backendNodeId, ref);
      this.emit("Pressed", `${key} on ${this.label(ref)}`, await this.centerOf(backendNodeId));
      await this.send("DOM.focus", { backendNodeId }).catch(() => {
        throw new DriverError("not_actionable", `Can't focus ${ref}: it doesn't take keyboard focus. Press without --ref, or pick a field or button.`);
      });
    } else {
      this.emit("Pressed", key);
    }
    await this.pressKey(key);
    await this.settle();
  }

  /** Picks options of a <select> by value or visible text. Returns the values picked. */
  async select(ref: string, values: string[]): Promise<string[]> {
    const backendNodeId = this.backendNode(ref);
    const objectId = await this.resolve(backendNodeId, ref);
    const point = await this.centerOf(backendNodeId);
    const picked = await this.callOn(
      objectId,
      `function (values) {
        if (this.tagName !== "SELECT") throw new Error("it isn't a <select>");
        if (this.disabled) throw new Error("it's disabled");
        if (!this.multiple && values.length > 1) throw new Error("it only takes one option");
        const options = Array.from(this.options);
        const chosen = values.map((v) => options.find((o) => o.value === v || o.label === v || o.textContent.trim() === v));
        const missing = values.filter((v, i) => !chosen[i]);
        if (missing.length) throw new Error("no option " + missing.map((m) => JSON.stringify(m)).join(", ") + "; it has " + options.map((o) => JSON.stringify(o.label)).join(", "));
        for (const o of options) o.selected = chosen.includes(o);
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return chosen.map((o) => o.value);
      }`,
      [values],
      ref
    );
    this.emit(`Picked ${values.join(", ")} in`, this.label(ref), point);
    await this.settle();
    return Array.isArray(picked) ? picked.map(String) : [];
  }

  /** Waits for the page to finish loading after a navigation. */
  async waitForLoad(): Promise<void> {
    await this.settle();
  }

  // ---- Internals ----

  private label(ref: string): string {
    return this.labels.get(ref) ?? ref;
  }

  private emit(verb: string, target: string, point?: { x: number; y: number }): void {
    try {
      this.onActivity?.({ verb, target, point });
    } catch {
      // The view's display never stops the agent.
    }
  }

  private requirePage(): GuestPage {
    if (!this.page || this.page.isDestroyed()) throw new DriverError("page_error", "The page has closed");
    return this.page;
  }

  private session(): DebuggerSession {
    if (this.debugger?.isAttached()) return this.debugger;
    const page = this.requirePage();
    const session = page.attachDebugger();
    this.debugger = session;
    // Refs point into one document; a new one makes them meaningless.
    this.unsubscribers.push(
      session.onEvent((method, params) => {
        if (method !== "Page.frameNavigated") return;
        const frame = (params as { frame?: { parentId?: unknown } } | null)?.frame;
        if (frame && frame.parentId === undefined) {
          this.refs.clear();
          this.errorCount = 0;
        }
      })
    );
    void session.send("Page.enable").catch(() => undefined);
    return session;
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.session().send(method, params);
    } catch (err) {
      if (err instanceof DriverError) throw err;
      throw new DriverError("page_error", `${method} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } } | null;
    return result?.result?.value;
  }

  private backendNode(ref: string): number {
    const id = this.refs.get(ref);
    if (id === undefined) this.staleRef(ref);
    return id;
  }

  private staleRef(ref: string): never {
    throw new DriverError("stale_ref", `No element ${ref} on the page now. Take a new snapshot; refs change when the page does.`);
  }

  private async resolve(backendNodeId: number, ref: string): Promise<string> {
    let result: unknown;
    try {
      result = await this.session().send("DOM.resolveNode", { backendNodeId });
    } catch {
      this.staleRef(ref);
    }
    const objectId = (result as { object?: { objectId?: unknown } } | null)?.object?.objectId;
    if (typeof objectId !== "string") this.staleRef(ref);
    return objectId;
  }

  /** Runs a function with `this` bound to the element; its throw becomes a not_actionable error. */
  private async callOn(objectId: string, functionDeclaration: string, args: unknown[], ref: string): Promise<unknown> {
    const result = (await this.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: unknown }; text?: unknown } } | null;
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description;
      const message = typeof description === "string" ? description.split("\n")[0]!.replace(/^Error: /, "") : String(result.exceptionDetails.text);
      throw new DriverError("not_actionable", `Can't use ${ref}: ${message}`);
    }
    return result?.result?.value;
  }

  /** The middle of an element, scrolled into view first, or undefined when
   *  it has no box (hidden, or gone). Only for showing where the agent acts. */
  private async centerOf(backendNodeId: number): Promise<{ x: number; y: number } | undefined> {
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
    const quads = (await this.send("DOM.getContentQuads", { backendNodeId }).catch(() => null)) as { quads?: unknown } | null;
    const quad = Array.isArray(quads?.quads) ? (quads.quads as unknown[]).find((q): q is number[] => Array.isArray(q) && q.length === 8) : undefined;
    if (!quad) return undefined;
    return { x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 };
  }

  /**
   * Where to click: the middle of the element once it's scrolled into view,
   * checked to be visible, enabled, and not covered by something else, as
   * Playwright checks before it clicks.
   */
  private async actionPoint(ref: string): Promise<{ x: number; y: number }> {
    const backendNodeId = this.backendNode(ref);
    const objectId = await this.resolve(backendNodeId, ref);
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
    const quads = (await this.send("DOM.getContentQuads", { backendNodeId }).catch(() => null)) as { quads?: unknown } | null;
    const quad = Array.isArray(quads?.quads) ? (quads.quads as unknown[]).find((q): q is number[] => Array.isArray(q) && q.length === 8) : undefined;
    if (!quad) throw new DriverError("not_actionable", `Can't click ${ref}: it isn't visible`);
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await this.callOn(
      objectId,
      `function (x, y) {
        if (this.disabled || (this.getAttribute && this.getAttribute("aria-disabled") === "true")) throw new Error("it's disabled");
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== this && !this.contains(hit) && !hit.contains(this)) {
          const name = hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + (typeof hit.className === "string" && hit.className ? "." + hit.className.trim().split(/\\s+/).join(".") : "");
          throw new Error("something else is on top of it (" + name + ")");
        }
      }`,
      [x, y],
      ref
    );
    return { x, y };
  }

  private async pressKey(spec: string): Promise<void> {
    let stroke;
    try {
      stroke = parseKey(spec);
    } catch (err) {
      throw new DriverError("not_actionable", err instanceof Error ? err.message : String(err));
    }
    const page = this.requirePage();
    page.sendKeyEvent("keyDown", stroke.electronKey, stroke.modifiers);
    if (stroke.text) page.sendKeyEvent("char", stroke.text, stroke.modifiers);
    page.sendKeyEvent("keyUp", stroke.electronKey, stroke.modifiers);
  }

  /** Lets what an action started happen: a moment for handlers to run, then
   *  any navigation it began to finish loading. */
  private async settle(): Promise<void> {
    await sleep(SETTLE_MS);
    const page = this.requirePage();
    const until = Date.now() + LOAD_WAIT_MS;
    while (page.isLoading() && Date.now() < until) await sleep(POLL_MS);
  }
}
