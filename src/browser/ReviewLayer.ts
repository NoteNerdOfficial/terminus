import { Notice, setIcon, setTooltip } from "obsidian";
import { TerminusMenu } from "../views/TerminusMenu";
import { INTENTS, INTENT_ICONS, bindTextKeys, renderComposerFields, renderShortcutHint, reviewIcon } from "../review/composer";
import type { AgentBrowser } from "./AgentBrowser";
import type { AgentBrowserView } from "./AgentBrowserView";
import type { Rect } from "./BrowserDriver";
import { pinInSight, type PinPlace, type PinState } from "./pinPlace";
import { INTENT_HINTS, INTENT_LABELS, STATUS_LABELS, elementLabel, siteOfPageKey, type Fingerprint, type PickedElement, type ReviewIntent, type ReviewNote } from "./review";

/** How often pins follow their elements while the page scrolls or changes. */
const PIN_POLL_MS = 120;
/** A pin's size, and where its tip is: the bottom-left corner. */
const PIN_HEIGHT = 22;
const PIN_TIP_X = 1;
/** One line each, for the empty tray. */
const INTENT_SHORT: Record<ReviewIntent, string> = {
  change: "asks the agent for an edit.",
  question: "asks without changing anything.",
  keep: "protects what's already right.",
};
/** How long after a page load to look at kept elements: the page settles first. */
const KEEP_CHECK_DELAY_MS = 800;

interface Pending {
  element: PickedElement;
  rect: Rect | null;
  /** Which slide or screen it's on. */
  place: PinPlace | null;
  /** Where the user clicked, in the page's viewport. */
  point: { x: number; y: number };
  screenshotPath: string | null;
}

/**
 * Review mode for a browser view: the user picks elements on the page and
 * leaves notes on them, which stay pinned there; the notes go to an agent
 * as one message; the agent answers each in place (`browser reply`), and
 * the user checks the fix and accepts it or follows up. See review.ts for
 * the notes themselves.
 *
 * Draws three things: pins over the page (the only part that takes the
 * pointer, so the page stays usable), the composer that opens on a picked
 * element, and the tray beside the page that lists this page's notes.
 */
export class ReviewLayer {
  private layerEl: HTMLElement;
  private outlineEl: HTMLElement;
  private composerEl: HTMLElement | null = null;
  private trayEl: HTMLElement;
  private hintEl: HTMLElement;
  /** Over the page while picking: catches the pointer so a click picks
   *  rather than reaches the page, and knows exactly where it landed. */
  private pickSurface: HTMLElement;
  private hoverFrame = 0;
  private ghostPin: HTMLElement | null = null;
  private hoverPoint: { x: number; y: number } | null = null;
  private picking = false;
  private pending: Pending | null = null;
  private pollTimer = 0;
  private polling = false;
  /** Where each pin's element is now, from the last poll. */
  private pins = new Map<string, PinState>();
  private pinEls = new Map<string, HTMLElement>();
  private focusedNote: string | null = null;
  /** Which note's follow-up or edit box is open in the tray. */
  private editing: { id: string; kind: "edit" | "follow-up" } | null = null;
  private offBook: () => void;
  /** Called when picking turns on or off, for the toolbar. */
  onModeChange: (() => void) | null = null;

  constructor(
    private readonly view: AgentBrowserView,
    private readonly browser: AgentBrowser,
    stage: HTMLElement,
    trayHost: HTMLElement
  ) {
    this.layerEl = stage.createDiv({ cls: "terminus-review-layer" });
    this.outlineEl = this.layerEl.createDiv({ cls: "terminus-review-outline" });
    this.outlineEl.hide();
    this.pickSurface = this.layerEl.createDiv({ cls: "terminus-review-pick-surface" });
    this.pickSurface.hide();
    this.bindPickSurface();
    // A bar between the toolbar and the page while picking: it says what a
    // click does and how to stop, without covering any of the page.
    this.hintEl = createDiv({ cls: "terminus-review-bar", attr: { role: "status" } });
    reviewIcon(this.hintEl, "crosshair", "terminus-review-bar-icon");
    this.hintEl.createSpan({ cls: "terminus-review-bar-text", text: "Click any element to comment on it." });
    const done = this.hintEl.createEl("button", { cls: "terminus-review-bar-done", text: "Done", attr: { type: "button" } });
    done.addEventListener("click", () => void this.stopPicking());
    trayHost.parentElement?.insertBefore(this.hintEl, trayHost);
    this.hintEl.hide();
    this.trayEl = trayHost.createDiv({ cls: "terminus-review-tray" });
    this.trayEl.hide();
    this.offBook = browser.review.onChange((note) => this.onBookChange(note));
  }

  dispose(): void {
    window.cancelAnimationFrame(this.hoverFrame);
    this.hintEl.remove();
    window.clearTimeout(this.keepCheckTimer);
    this.offBook();
    window.clearTimeout(this.pollTimer);
    this.polling = false;
    void this.view.driver.stopPicking().catch(() => undefined);
  }

  get isPicking(): boolean {
    return this.picking;
  }

  get trayOpen(): boolean {
    return this.trayEl.isShown();
  }

  /** Whether the user is writing a comment, an edit or a follow-up, which a
   *  reload of the page would throw away. */
  get isComposing(): boolean {
    return this.pending !== null || this.editing !== null;
  }

  /** Notes on the page showing now. */
  notesHere(): ReviewNote[] {
    const url = this.view.currentUrl();
    return url ? this.browser.review.forPage(this.browser.pageKey(this.view, url)) : [];
  }

  // ---- Picking ----

  async togglePicking(): Promise<void> {
    if (this.picking) return this.stopPicking();
    if (!this.view.currentUrl() || this.view.currentUrl() === "about:blank") {
      new Notice("Terminus: open a page first");
      return;
    }
    try {
      await this.view.whenReady();
      await this.view.driver.startPicking(this.accentRgb());
    } catch (err) {
      new Notice(`Terminus: couldn't start review mode: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.picking = true;
    this.pickSurface.show();
    this.hintEl.show();
    this.view.contentEl.addClass("is-reviewing");
    this.openTray();
    this.renderTray();
    this.onModeChange?.();
  }

  async stopPicking(): Promise<void> {
    if (!this.picking) return;
    this.picking = false;
    this.closeComposer();
    this.pickSurface.hide();
    this.hintEl.hide();
    this.view.contentEl.removeClass("is-reviewing");
    await this.view.driver.stopPicking().catch(() => undefined);
    this.renderTray();
    this.onModeChange?.();
  }

  /** Escape from Obsidian's side (focus outside the page). */
  handleEscape(): boolean {
    if (this.composerEl) {
      this.cancelComposer();
      return true;
    }
    if (this.picking) {
      void this.stopPicking();
      return true;
    }
    return false;
  }

  private bindPickSurface(): void {
    const surface = this.pickSurface;
    const local = (event: MouseEvent): { x: number; y: number } => {
      const box = surface.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    // Hover: outline what's under the pointer, at most once a frame.
    surface.addEventListener("pointermove", (event) => {
      this.hoverPoint = local(event);
      if (this.hoverFrame) return;
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = 0;
        const point = this.hoverPoint;
        if (!point || !this.picking || this.pending) return;
        void this.view.driver.nodeAt(point.x, point.y).then((id) => {
          if (this.picking && !this.pending) void this.view.driver.highlight(id);
        });
      });
    });
    surface.addEventListener("pointerleave", () => {
      this.hoverPoint = null;
      void this.view.driver.highlight(null);
    });
    surface.addEventListener("click", (event) => {
      event.preventDefault();
      void this.pickAt(local(event));
    });
    // The page still scrolls under the surface.
    surface.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const point = local(event);
        void this.view.driver.scrollBy(point.x, point.y, event.deltaX, event.deltaY);
      },
      { passive: false }
    );
  }

  private async pickAt(point: { x: number; y: number }): Promise<void> {
    if (this.pending || !this.picking) return;
    const id = await this.view.driver.nodeAt(point.x, point.y);
    if (id !== null) await this.onPicked(id, point);
  }

  private async onPicked(backendNodeId: number, point: { x: number; y: number }): Promise<void> {
    if (this.pending) return;
    const driver = this.view.driver;
    // Off, or it would be in the element's screenshot.
    await driver.highlight(null);
    this.pickSurface.hide();
    let described: { element: PickedElement; rect: Rect | null; place: PinPlace | null };
    try {
      described = await driver.describeNode(backendNodeId);
    } catch (err) {
      new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`);
      if (this.picking) this.pickSurface.show();
      return;
    }
    let screenshotPath: string | null = null;
    if (described.rect && this.view.isShown()) {
      const png = await driver.captureRect(described.rect).catch(() => null);
      if (png) screenshotPath = await this.browser.saveReviewImage(this.view.publicId, png).catch(() => null);
    }
    this.pending = { ...described, point, screenshotPath };
    this.openComposer(this.pending);
  }

  // ---- Composer ----

  private openComposer(pending: Pending): void {
    this.closeComposer();
    const card = this.layerEl.createDiv({ cls: "terminus-review-composer" });
    this.composerEl = card;
    if (pending.rect) this.showOutline(pending.rect);
    // Where the pin will go, shown while the comment is written.
    this.ghostPin = this.layerEl.createDiv({ cls: "terminus-review-pin is-ghost", attr: { "aria-hidden": "true" } });
    this.ghostPin.style.left = `${pending.point.x - PIN_TIP_X}px`;
    this.ghostPin.style.top = `${pending.point.y - PIN_HEIGHT}px`;

    const head = card.createDiv({ cls: "terminus-review-composer-head" });
    head.createSpan({ cls: "terminus-review-element", text: elementLabel(pending.element) });
    const fields = renderComposerFields(card);
    const actions = card.createDiv({ cls: "terminus-review-composer-actions" });
    renderShortcutHint(actions);
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    const add = actions.createEl("button", { cls: "mod-cta", text: "Add", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.cancelComposer());
    const submit = (): void => {
      const text = fields.text();
      if (text === null) {
        fields.textarea.focus();
        return;
      }
      void this.addNote(pending, fields.intent(), text);
    };
    add.addEventListener("click", submit);
    bindTextKeys(fields.textarea, submit, () => this.cancelComposer());
    this.placeComposer(card, pending.point);
    window.setTimeout(() => fields.textarea.focus(), 0);
  }

  /** Just below where the user clicked, or above it when there's no room. */
  private placeComposer(card: HTMLElement, point: { x: number; y: number }): void {
    const width = this.layerEl.clientWidth;
    const height = this.layerEl.clientHeight;
    const cardWidth = Math.min(340, width - 16);
    card.style.width = `${cardWidth}px`;
    const cardHeight = card.offsetHeight || 190;
    let left = point.x - 16;
    let top = point.y + 14;
    if (top + cardHeight > height - 8) top = point.y - cardHeight - 30;
    left = Math.max(8, Math.min(left, width - cardWidth - 8));
    top = Math.max(8, Math.min(top, height - cardHeight - 8));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  private async addNote(pending: Pending, intent: ReviewIntent, text: string): Promise<void> {
    const url = this.view.currentUrl() ?? "";
    // How a kept element looks now, so a later change to it can be noticed.
    const baseline = intent === "keep" ? ((await this.view.driver.fingerprintsFor([pending.element.selector]).catch(() => [null]))[0] ?? null) : null;
    try {
      const note = this.browser.review.add({
        pageKey: this.browser.pageKey(this.view, url),
        pageUrl: this.browser.displayUrl(url, this.view),
        href: url.split(/[?#]/, 1)[0] ?? url,
        pageTitle: this.view.getDisplayText(),
        sourcePath: this.browser.sourceFor(this.view, url),
        element: pending.element,
        intent,
        text,
        screenshotPath: pending.screenshotPath,
        baseline,
        anchor: anchorWithin(pending.point, pending.rect),
        place: pending.place,
      });
      this.focusedNote = note.id;
    } catch (err) {
      new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.closeComposer();
    if (this.picking) this.pickSurface.show();
  }

  private cancelComposer(): void {
    this.closeComposer();
    if (this.picking) this.pickSurface.show();
  }

  private closeComposer(): void {
    this.composerEl?.remove();
    this.composerEl = null;
    this.ghostPin?.remove();
    this.ghostPin = null;
    this.pending = null;
    this.outlineEl.hide();
  }

  // ---- Pins ----

  /** From the view when the page changes: pins for the new page. */
  pageChanged(): void {
    this.closeComposer();
    this.pins.clear();
    this.render();
    void this.view.driver.highlight(null);
    this.scheduleKeepCheck();
  }

  // ---- Keep ----

  private keepCheckTimer = 0;

  /** Looks at the page's kept elements once it has settled. */
  scheduleKeepCheck(delay = KEEP_CHECK_DELAY_MS): void {
    window.clearTimeout(this.keepCheckTimer);
    this.keepCheckTimer = window.setTimeout(() => void this.checkKeeps(), delay);
  }

  /**
   * Compares each kept element on this page with how it looked when it was
   * kept, and says so when one has changed. Run after every page load,
   * which is when an agent's edits show up, and after an agent answers.
   */
  private async checkKeeps(): Promise<void> {
    if (!this.view.isShown() && !this.view.currentUrl()) return;
    const keeps = this.notesHere().filter((note) => note.intent === "keep" && note.baseline);
    if (keeps.length === 0) return;
    let looks: (Fingerprint | null)[];
    try {
      looks = await this.view.driver.fingerprintsFor(keeps.map((note) => note.element.selector));
    } catch {
      return; // Still loading; the next load checks again.
    }
    const changed: ReviewNote[] = [];
    keeps.forEach((note, i) => {
      if (this.browser.review.checkKeep(note.id, looks[i] ?? null)) changed.push(note);
    });
    if (changed.length) {
      const first = changed[0]!;
      const what = first.drift?.changes[0] ?? "it changed";
      new Notice(
        changed.length === 1
          ? `Terminus: Keep ${first.id.slice(1)} changed (${what})`
          : `Terminus: ${changed.length} kept elements changed on this page`,
        8000
      );
      this.focusedNote = first.id;
      this.openTray();
    }
  }

  private onBookChange(note: ReviewNote | null): void {
    // An agent's answer usually comes with edits: look at the Keeps again.
    if (note && note.thread[note.thread.length - 1]?.by === "agent") this.scheduleKeepCheck();
    // An agent's answer is worth saying even when the tray is closed.
    if (note && (note.status === "fixed" || note.status === "answered") && note.thread[note.thread.length - 1]?.by === "agent") {
      const here = this.notesHere().some((n) => n.id === note.id);
      if (here) {
        const who = note.thread[note.thread.length - 1]!.who ?? "The agent";
        new Notice(`Terminus: ${who} ${note.status === "fixed" ? "made a change for you to check on" : "answered"} comment ${note.id.slice(1)}`);
        this.openTray();
      }
    }
    this.render();
  }

  /** Draws the pins and the tray for the page showing now. */
  render(): void {
    const notes = this.notesHere();
    const live = new Set(notes.map((n) => n.id));
    for (const [id, el] of this.pinEls) {
      if (!live.has(id)) {
        el.remove();
        this.pinEls.delete(id);
      }
    }
    for (const note of notes) {
      let pin = this.pinEls.get(note.id);
      if (!pin) {
        pin = this.layerEl.createEl("button", { cls: "terminus-review-pin", attr: { type: "button" } });
        const id = note.id;
        pin.addEventListener("click", () => {
          this.focusedNote = id;
          this.openTray();
          this.renderTray();
          this.trayEl.querySelector(`[data-note="${id}"]`)?.scrollIntoView({ block: "nearest" });
        });
        pin.addEventListener("mouseenter", () => this.outlineFor(id));
        pin.addEventListener("mouseleave", () => this.outlineEl.hide());
        this.pinEls.set(note.id, pin);
      }
      pin.empty();
      if (note.intent === "keep") reviewIcon(pin, note.drift ? "alert-triangle" : "lock", "terminus-review-pin-icon");
      pin.createSpan({ text: note.id.slice(1) });
      pin.dataset.status = note.status;
      pin.dataset.intent = note.intent;
      pin.toggleClass("has-drift", note.drift !== null);
      pin.toggleClass("is-focused", note.id === this.focusedNote);
      setTooltip(pin, `${INTENT_LABELS[note.intent]} · ${statusLabel(note)}${note.thread[0] ? `: ${note.thread[0].text}` : ""}`);
    }
    this.placePins();
    this.renderTray();
    this.schedulePoll();
  }

  /**
   * Puts each pin's tip where the user clicked, kept in step with the
   * element: the point is saved as a fraction across and down it, so the
   * pin follows a scroll, a reflow or a resize. A pin shows only while its
   * element is showing on the slide or screen it was left on, and its tip
   * can be seen: one scrolled out of the pane hides rather than sticking to
   * the edge, where it would look like it belonged to something else. Pins
   * that would land on the same spot sit side by side.
   */
  private placePins(): void {
    const taken = new Map<string, number>();
    const viewport = { width: this.layerEl.clientWidth, height: this.layerEl.clientHeight };
    for (const [id, pin] of this.pinEls) {
      const state = this.pins.get(id);
      const note = this.browser.review.get(id);
      if (!state || state.state !== "shown" || !note) {
        pin.hide();
        continue;
      }
      const anchor = note.anchor ?? { rx: 1, ry: 0 };
      const x = state.x + anchor.rx * state.width;
      const y = state.y + anchor.ry * state.height;
      if (!pinInSight(x, y, state.clip, viewport)) {
        pin.hide();
        continue;
      }
      pin.show();
      const spot = `${Math.round(x / 12)}:${Math.round(y / 12)}`;
      const shift = taken.get(spot) ?? 0;
      taken.set(spot, shift + pin.offsetWidth + 3);
      const left = Math.max(2, Math.min(x - PIN_TIP_X + shift, viewport.width - pin.offsetWidth - 4));
      pin.style.left = `${left}px`;
      pin.style.top = `${Math.max(2, y - PIN_HEIGHT)}px`;
    }
  }

  private schedulePoll(): void {
    if (this.polling || this.pinEls.size === 0) return;
    this.polling = true;
    const tick = async (): Promise<void> => {
      if (!this.polling) return;
      const notes = this.notesHere();
      if (notes.length === 0) {
        this.polling = false;
        return;
      }
      if (this.view.isShown()) {
        try {
          const states = await this.view.driver.pinsFor(notes.map((n) => ({ selector: n.element.selector, tag: n.element.tag, place: n.place })));
          notes.forEach((note, i) => {
            const state = states[i] ?? { state: "missing" };
            this.pins.set(note.id, state);
            if (state.state === "shown" && state.text !== undefined) this.browser.review.retext(note.id, state.text);
          });
        } catch {
          // Loading, or gone: try again next tick.
        }
        this.placePins();
        this.markMissing(notes);
      }
      if (this.polling) this.pollTimer = window.setTimeout(() => void tick(), PIN_POLL_MS);
    };
    void tick();
  }

  /** Tray cards whose element isn't on the page, or is on another slide
   *  or screen of it, say so. */
  private markMissing(notes: ReviewNote[]): void {
    for (const note of notes) {
      const card = this.trayEl.querySelector(`[data-note="${note.id}"]`);
      const state = this.pins.get(note.id)?.state;
      card?.toggleClass("is-missing", state === "missing");
      card?.toggleClass("is-other-view", state === "elsewhere");
    }
  }

  private outlineFor(id: string): void {
    const state = this.pins.get(id);
    if (state?.state === "shown") this.showOutline(state);
  }

  private showOutline(rect: Rect): void {
    this.outlineEl.style.left = `${rect.x}px`;
    this.outlineEl.style.top = `${rect.y}px`;
    this.outlineEl.style.width = `${rect.width}px`;
    this.outlineEl.style.height = `${rect.height}px`;
    this.outlineEl.show();
  }

  // ---- Tray ----

  openTray(): void {
    if (!this.trayEl.isShown()) {
      this.trayEl.show();
      this.renderTray();
      this.onModeChange?.();
    }
  }

  toggleTray(): void {
    if (this.trayEl.isShown()) {
      this.trayEl.hide();
      this.onModeChange?.();
    } else {
      this.openTray();
    }
  }

  private renderTray(): void {
    if (!this.trayEl.isShown()) return;
    const tray = this.trayEl;
    tray.empty();
    const notes = this.notesHere();
    const head = tray.createDiv({ cls: "terminus-review-tray-head" });
    const title = head.createSpan({ cls: "terminus-review-tray-title", text: "Comments" });
    if (notes.length) title.createSpan({ cls: "terminus-review-tray-count", text: String(notes.length) });
    const close = head.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Hide comments" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.toggleTray());

    const list = tray.createDiv({ cls: "terminus-review-list" });
    if (notes.length === 0) this.renderEmpty(list);
    for (const note of notes) this.renderCard(list, note);

    const elsewhere = this.browser.review.all().filter((n) => !notes.includes(n) && n.status !== "resolved" && this.sameSite(n));
    if (elsewhere.length) {
      const other = tray.createDiv({ cls: "terminus-review-elsewhere" });
      const pages = new Map<string, ReviewNote>();
      for (const n of elsewhere) if (!pages.has(n.pageKey)) pages.set(n.pageKey, n);
      other.createDiv({ cls: "terminus-browser-muted", text: `${elsewhere.length} more on other pages:` });
      for (const n of pages.values()) {
        const link = other.createEl("a", { text: n.pageTitle || n.pageUrl, attr: { href: "#" } });
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void this.view.navigate(this.view.urlForPage(n)).catch((err: unknown) => new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`));
        });
      }
    }

    const foot = tray.createDiv({ cls: "terminus-review-tray-foot" });
    const sendable = this.sendable();
    const send = foot.createEl("button", { cls: "mod-cta", attr: { type: "button" } });
    reviewIcon(send, "send");
    send.createSpan({ text: sendable.length ? `Send ${sendable.length} to an agent` : "Nothing new to send" });
    send.disabled = sendable.length === 0;
    send.addEventListener("click", (event) => this.openSendMenu(event));
    const copy = foot.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Copy comments as Markdown" } });
    setIcon(copy, "copy");
    copy.disabled = sendable.length === 0;
    copy.addEventListener("click", () => void this.copyNotes());
    const done = notes.filter((n) => n.status === "resolved").length;
    if (done) {
      const clear = foot.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": `Clear ${done} done` } });
      setIcon(clear, "list-x");
      clear.addEventListener("click", () => this.browser.review.clear(this.notesHere()[0]!.pageKey, true));
    }
    this.markMissing(notes);
  }

  /** No comments here yet: what review is, and how to start. */
  private renderEmpty(list: HTMLElement): void {
    const empty = list.createDiv({ cls: "terminus-review-empty" });
    if (this.picking) {
      empty.createDiv({ cls: "terminus-review-empty-title", text: "Click any element on the page" });
      empty.createDiv({ text: "A box opens beside it for your comment." });
      return;
    }
    empty.createDiv({ cls: "terminus-review-empty-title", text: "No comments on this page" });
    const kinds = empty.createEl("ul", { cls: "terminus-review-kinds" });
    for (const value of INTENTS) {
      const item = kinds.createEl("li");
      reviewIcon(item, INTENT_ICONS[value], "terminus-review-kind-icon");
      const text = item.createSpan();
      text.createEl("strong", { text: INTENT_LABELS[value] });
      text.appendText(` ${INTENT_SHORT[value]}`);
    }
    const start = empty.createEl("button", { cls: "mod-cta", attr: { type: "button" } });
    reviewIcon(start, "crosshair");
    start.createSpan({ text: "Start reviewing" });
    start.addEventListener("click", () => void this.togglePicking());
  }

  private sameSite(note: ReviewNote): boolean {
    const url = this.view.currentUrl();
    if (!url) return false;
    return siteOfPageKey(note.pageKey) === siteOfPageKey(this.browser.pageKey(this.view, url));
  }

  private renderCard(list: HTMLElement, note: ReviewNote): void {
    const card = list.createDiv({ cls: "terminus-review-card", attr: { "data-note": note.id, "data-status": note.status } });
    card.toggleClass("is-focused", note.id === this.focusedNote);
    card.toggleClass("has-drift", note.drift !== null);
    card.addEventListener("mouseenter", () => this.outlineFor(note.id));
    card.addEventListener("mouseleave", () => this.outlineEl.hide());

    card.dataset.intent = note.intent;
    const head = card.createDiv({ cls: "terminus-review-card-head" });
    head.createSpan({ cls: "terminus-review-badge", text: note.id.slice(1) });
    const intent = head.createSpan({ cls: "terminus-review-card-intent" });
    reviewIcon(intent, INTENT_ICONS[note.intent]);
    intent.createSpan({ text: INTENT_LABELS[note.intent] });
    setTooltip(intent, `${INTENT_LABELS[note.intent]}: ${INTENT_HINTS[note.intent]}`);
    head.createSpan({ cls: "terminus-review-status", text: statusLabel(note) });
    const locate = head.createEl("button", { cls: "clickable-icon terminus-review-locate", attr: { type: "button", "aria-label": "Show on the page" } });
    setIcon(locate, "locate");
    locate.addEventListener("click", () => void this.reveal(note));

    // What the user said comes first; what it's about, second.
    const [first, ...rest] = note.thread;
    if (first?.by === "user") card.createDiv({ cls: "terminus-review-comment", text: first.text });
    card.createDiv({ cls: "terminus-review-element", text: elementLabel(note.element) });
    if (note.intent !== "keep") card.createDiv({ cls: "terminus-review-missing", text: "Not on the page now: it may have changed or moved." });
    card.createDiv({ cls: "terminus-review-other-view", text: "On another slide or screen of this page, or out of sight." });
    if (note.drift) {
      const drift = card.createDiv({ cls: "terminus-review-drift" });
      drift.createDiv({ cls: "terminus-review-drift-title", text: "Changed since you kept it" });
      const list = drift.createEl("ul");
      for (const change of note.drift.changes.slice(0, 6)) list.createEl("li", { text: change });
      if (note.drift.changes.length > 6) list.createEl("li", { text: `and ${note.drift.changes.length - 6} more` });
    }

    const replies = first?.by === "user" ? rest : note.thread;
    if (replies.length) {
      const thread = card.createDiv({ cls: "terminus-review-thread" });
      for (const entry of replies) {
        const row = thread.createDiv({ cls: `terminus-review-entry is-${entry.by}` });
        const who = row.createDiv({ cls: "terminus-review-who" });
        if (entry.by === "agent") reviewIcon(who, "bot", "terminus-review-who-icon");
        who.createSpan({ text: entry.by === "user" ? "You" : entry.who || "Agent" });
        row.createDiv({ cls: "terminus-review-entry-text", text: entry.text });
      }
    }

    if (this.editing?.id === note.id) {
      this.renderEditBox(card, note, this.editing.kind);
      return;
    }
    const actions = card.createDiv({ cls: "terminus-review-card-actions" });
    const button = (text: string, onClick: () => void, cta = false): void => {
      const b = actions.createEl("button", { text, cls: cta ? "mod-cta" : "", attr: { type: "button" } });
      b.addEventListener("click", onClick);
    };
    if (note.intent === "keep") {
      this.keepActions(note, button);
      return;
    }
    switch (note.status) {
      case "open":
        if (note.thread.length === 1) button("Edit", () => this.startEditing(note.id, "edit"));
        button("Delete", () => this.browser.review.remove(note.id));
        break;
      case "sent":
        actions.createSpan({ cls: "terminus-review-waiting", text: `Waiting on ${this.browser.terminalName(note.sentTo)}` });
        button("Follow up", () => this.startEditing(note.id, "follow-up"));
        break;
      case "fixed":
        button("Looks right", () => this.browser.review.resolve(note.id), true);
        button("Not yet…", () => this.startEditing(note.id, "follow-up"));
        break;
      case "answered":
        button("Done", () => this.browser.review.resolve(note.id), true);
        button("Reply…", () => this.startEditing(note.id, "follow-up"));
        break;
      case "resolved":
        button("Reopen…", () => this.startEditing(note.id, "follow-up"));
        button("Delete", () => this.browser.review.remove(note.id));
        break;
    }
  }

  /** A Keep never waits on an answer: it's edited until sent, then stands
   *  until removed, and asks for a decision only when its element changed. */
  private keepActions(note: ReviewNote, button: (text: string, onClick: () => void, cta?: boolean) => void): void {
    if (note.drift) {
      button("Ask to restore", () => this.browser.review.requestRestore(note.id), true);
      button(note.drift.current ? "Keep new look" : "Remove", () => this.browser.review.acceptDrift(note.id));
      return;
    }
    if (note.status === "open" && note.thread.length <= 1) button("Edit", () => this.startEditing(note.id, "edit"));
    button("Remove", () => this.browser.review.remove(note.id));
  }

  private startEditing(id: string, kind: "edit" | "follow-up"): void {
    this.editing = { id, kind };
    this.renderTray();
    this.trayEl.querySelector<HTMLTextAreaElement>(`[data-note="${id}"] textarea`)?.focus();
  }

  private renderEditBox(card: HTMLElement, note: ReviewNote, kind: "edit" | "follow-up"): void {
    const box = card.createDiv({ cls: "terminus-review-edit" });
    const textarea = box.createEl("textarea", {
      cls: "terminus-review-text",
      attr: { rows: "3", placeholder: kind === "edit" ? "" : "What still needs to change?", "aria-label": kind === "edit" ? "Edit note" : "Follow-up" },
    });
    if (kind === "edit") textarea.value = note.thread[0]?.text ?? "";
    const actions = box.createDiv({ cls: "terminus-review-card-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    const save = actions.createEl("button", { cls: "mod-cta", text: kind === "edit" ? "Save" : "Add follow-up", attr: { type: "button" } });
    const finish = (): void => {
      this.editing = null;
      this.renderTray();
    };
    cancel.addEventListener("click", finish);
    const submit = (): void => {
      try {
        if (kind === "edit") this.browser.review.edit(note.id, textarea.value, note.intent);
        else this.browser.review.followUp(note.id, textarea.value);
        finish();
      } catch (err) {
        new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    save.addEventListener("click", submit);
    bindTextKeys(textarea, submit, finish);
  }

  /** Scrolls the note's element into view and outlines it. */
  private async reveal(note: ReviewNote): Promise<void> {
    this.focusedNote = note.id;
    try {
      await this.view.driver.scrollToPin({ selector: note.element.selector, tag: note.element.tag, place: note.place });
    } catch {
      // Not on the page; the card already says so.
    }
    this.render();
    window.setTimeout(() => this.outlineFor(note.id), PIN_POLL_MS * 2);
    window.setTimeout(() => this.outlineEl.hide(), 1600);
  }

  // ---- Sending ----

  /** Open notes on this page and the site's other pages. */
  private sendable(): ReviewNote[] {
    return this.browser.review.all().filter((n) => n.status === "open" && (this.notesHere().includes(n) || this.sameSite(n)));
  }

  private openSendMenu(event: MouseEvent): void {
    const notes = this.sendable();
    if (notes.length === 0) return;
    const targets = this.browser.reviewTargets(this.view);
    const menu = new TerminusMenu();
    for (const target of targets) {
      menu.addItem((item) =>
        item
          .setTitle(target.label)
          .setIcon("bot")
          .setDescription(target.reason)
          .onClick(() => this.send(notes, target.token))
      );
    }
    if (targets.length) menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("New Claude session")
        .setIcon("plus")
        .setDescription(targets.length ? "In a new terminal" : "No Claude session is running")
        .onClick(() => void this.sendToNewSession(notes))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Copy as Markdown")
        .setIcon("copy")
        .onClick(() => void this.copyNotes())
    );
    menu.showAtMouseEvent(event);
  }

  private send(notes: ReviewNote[], token: string): void {
    try {
      const result = this.browser.sendReview(this.view, notes, token);
      new Notice(`Terminus: ${result}`);
    } catch (err) {
      new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  private async sendToNewSession(notes: ReviewNote[]): Promise<void> {
    try {
      const result = await this.browser.sendReviewToNewSession(this.view, notes);
      new Notice(`Terminus: ${result}`);
    } catch (err) {
      new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  private async copyNotes(): Promise<void> {
    const notes = this.sendable();
    if (notes.length === 0) return;
    await navigator.clipboard.writeText(this.browser.reviewPrompt(this.view, notes, false));
    new Notice(`Terminus: copied ${notes.length === 1 ? "1 comment" : `${notes.length} comments`}`);
  }

  /** Obsidian's accent (or the agent's colour) as RGB, for the page's own highlight. */
  private accentRgb(): { r: number; g: number; b: number } {
    const probe = this.view.contentEl.createSpan({ cls: "terminus-review-color-probe" });
    const color = getComputedStyle(probe).color;
    probe.remove();
    const match = color.match(/\d+(\.\d+)?/g);
    if (!match || match.length < 3) return { r: 124, g: 58, b: 237 };
    return { r: Math.round(Number(match[0])), g: Math.round(Number(match[1])), b: Math.round(Number(match[2])) };
  }
}

/** A comment's state in words. A Keep has its own: it never waits on an answer. */
function statusLabel(note: ReviewNote): string {
  if (note.intent !== "keep") return STATUS_LABELS[note.status];
  if (note.drift) return note.status === "open" ? "Changed · not sent" : "Changed";
  return note.status === "open" ? "Not sent" : "Agent told";
}

/** Where a click fell within an element, as fractions across and down it. */
function anchorWithin(point: { x: number; y: number }, rect: Rect | null): { rx: number; ry: number } | null {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  return { rx: clamp((point.x - rect.x) / rect.width), ry: clamp((point.y - rect.y) / rect.height) };
}
