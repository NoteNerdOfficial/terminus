import { ItemView, Notice, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { guestPageForWebContentsId, webContentsIdOf, type GuestPage } from "terminus-node-bridge";
import { AgentCursor, type Expression } from "./agentCursor";
import { BrowserDriver, type BrowserActivity } from "./BrowserDriver";
import { isAllowedBrowserUrl } from "./policy";
import type { AgentBrowser } from "./AgentBrowser";
import { ReviewLayer } from "./ReviewLayer";
import type { ReviewNote } from "./review";
import { withoutQuery } from "./sites";

export const AGENT_BROWSER_VIEW_TYPE = "terminus-agent-browser";

/** Its own session, in memory only: nothing the agent's pages store
 *  (cookies, localStorage) survives a restart, and none of it is shared
 *  with Obsidian's Web viewer, where the user may be signed in to things. */
export const AGENT_BROWSER_PARTITION = "terminus-agent-browser";

const ERR_ABORTED = -3;
/** How long the edge and the cursor's bubble stay after the last action. */
const ACTING_MS = 2500;
/** How long after the file behind the page changes to reload it: an agent
 *  often writes a file several times in a row. Longer for a note, whose
 *  page a site may have to build again, and which Obsidian saves as the
 *  user types. */
const SOURCE_SETTLE_MS = 400;
const NOTE_SETTLE_MS = 1500;
/** While the user is writing a comment, a reload would lose it: wait. */
const COMPOSING_RETRY_MS = 1000;

export interface AgentBrowserViewState {
  url?: string;
  /** The terminal (hook token) of the agent driving it. */
  ownerToken?: string;
  ownerLabel?: string;
}

declare global {
  /** Electron's <webview>, which Obsidian's desktop app allows. */
  interface HTMLElementTagNameMap {
    webview: HTMLElement;
  }
}

/** The extra fields Electron puts on a <webview>'s DOM events. */
interface FailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}
interface NavigateEvent extends Event {
  url: string;
}
interface StartNavigationEvent extends NavigateEvent {
  isMainFrame: boolean;
  isInPlace: boolean;
}
interface TitleEvent extends Event {
  title: string;
}

/**
 * A browser an agent drives: a <webview> in its own locked-down session
 * that only opens pages on this computer (see AgentBrowser for the policy,
 * StaticSites for how a folder is served).
 *
 * Three things say an agent is at the wheel, all in its group's colour: a
 * strip along the top (who, and where); while it acts, a thin edge around
 * the page; and its own cursor on the page, with a small companion that
 * moves to each element it clicks or types into, acts it out and says what
 * it's doing (see AgentCursor).
 *
 * Doesn't survive a restart: the agent and the address it was served at
 * are both gone by then, so AgentBrowser closes any that Obsidian restores.
 */
export class AgentBrowserView extends ItemView {
  private state: AgentBrowserViewState = {};
  private webview: HTMLElement | null = null;
  private page: GuestPage | null = null;
  private ready: Promise<GuestPage> | null = null;
  private resolveReady: ((page: GuestPage) => void) | null = null;
  private title = "";
  /** The blank page the view starts on is dropped from history once a real
   *  page has loaded, so going back can't land there. */
  private historyCleared = false;
  /** Set once the first page has loaded; later ones get a reaction. */
  private loadedOnce = false;
  private urlEl: HTMLElement | null = null;
  private ownerEl: HTMLElement | null = null;
  private noticeEl: HTMLElement | null = null;
  private iconEl: HTMLElement | null = null;
  private reviewButton: HTMLElement | null = null;
  private notesButton: HTMLElement | null = null;
  private review: ReviewLayer | null = null;
  private offReview: (() => void) | null = null;
  private cursor: AgentCursor | null = null;
  private actingTimer = 0;
  private sourceTimer = 0;
  /** A reload in progress, and whether another was asked for meanwhile. */
  private reloading: Promise<void> | null = null;
  private reloadAgain = false;
  /** Folders served for this view, stopped when it closes. */
  readonly servedSiteIds = new Set<string>();
  /** What agents drive the page through. */
  readonly driver = new BrowserDriver((action) => this.keepingFocus(action));
  /** What agents call it (`b1`); given by AgentBrowser when it opens. */
  publicId = "";
  /** The plugin site it shows (see sites.ts), if it was opened as one. */
  registeredSiteId: string | null = null;
  /** That site's first address, which may carry its token: never shown,
   *  saved or handed to an agent. */
  secretUrl: string | null = null;
  /** Terminals the user sent review notes to: their agents can reach this
   *  browser as if they'd opened it, to check their work and answer. */
  readonly sharedWith = new Set<string>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly browser: AgentBrowser
  ) {
    super(leaf);
  }

  getViewType(): string {
    return AGENT_BROWSER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.title || (this.ownerToken ? "Agent browser" : "Terminus browser");
  }

  getIcon(): string {
    return "globe";
  }

  get ownerToken(): string | null {
    return this.state.ownerToken ?? null;
  }

  getState(): Record<string, unknown> {
    // A plugin site's address can carry its token; the layout file is no place for it.
    const url = this.registeredSiteId && this.state.url ? withoutQuery(this.state.url) : this.state.url;
    return { ...this.state, url };
  }

  /** The address showing now, or null before the first page. */
  currentUrl(): string | null {
    try {
      return this.page && !this.page.isDestroyed() ? this.page.getURL() : (this.state.url ?? null);
    } catch {
      return this.state.url ?? null;
    }
  }

  /** Where to go back to a note's page: on a plugin site, at the site's
   *  address now (its port can change between runs). */
  urlForPage(note: ReviewNote): string {
    const now = this.currentUrl();
    if (this.registeredSiteId && now) {
      try {
        const target = new URL(note.href);
        return new URL(target.pathname, new URL(now).origin).toString();
      } catch {
        // Fall through.
      }
    }
    return note.href;
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const next = (state ?? {}) as AgentBrowserViewState;
    const urlChanged = next.url !== undefined && next.url !== this.state.url;
    this.state = { ...this.state, ...next };
    await super.setState(state, result);
    this.renderStrip();
    if (urlChanged && next.url) await this.navigate(next.url);
  }

  async onOpen(): Promise<void> {
    this.browser.prepareSession();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("terminus-agent-browser");

    const bar = contentEl.createDiv({ cls: "terminus-agent-browser-bar" });
    this.iconEl = bar.createSpan({ cls: "terminus-agent-browser-icon" });
    const back = this.barButton(bar, "arrow-left", "Back", () => {
      if (this.page?.canGoBack()) this.page.goBack();
    });
    back.addClass("terminus-agent-browser-back");
    this.ownerEl = bar.createSpan({ cls: "terminus-agent-browser-owner" });
    this.urlEl = bar.createSpan({ cls: "terminus-agent-browser-url" });
    // Review is the one labelled control: it changes what a click on the
    // page does, so its state has to be readable at a glance.
    this.reviewButton = bar.createEl("button", { cls: "terminus-review-toggle", attr: { type: "button", "aria-pressed": "false" } });
    setIcon(this.reviewButton.createSpan({ cls: ["terminus-review-icon", "terminus-review-toggle-icon"] }), "crosshair");
    this.reviewButton.createSpan({ cls: "terminus-review-toggle-label", text: "Review" });
    setTooltip(this.reviewButton, "Click elements on the page to comment on them");
    this.reviewButton.addEventListener("click", () => void this.review?.togglePicking());
    this.notesButton = this.barButton(bar, "messages-square", "Comments", () => this.review?.toggleTray());
    this.notesButton.addClass("terminus-agent-browser-notes");
    this.barButton(bar, "rotate-cw", "Reload", () => void this.reloadReporting());
    this.noticeEl = contentEl.createDiv({ cls: "terminus-agent-browser-notice" });
    this.noticeEl.hide();

    // The page, with the agent's edge, ripples and cursor laid over it. The
    // overlays take no pointer events, so they never get in the user's way;
    // review pins (ReviewLayer) are the one exception. The review tray sits
    // beside the page.
    const body = contentEl.createDiv({ cls: "terminus-agent-browser-body" });
    const stage = body.createDiv({ cls: "terminus-agent-browser-stage" });

    // The partition has to be set before the element is attached; Obsidian
    // strips preload scripts and Node access from every <webview> as it
    // attaches. No `allowpopups`, so window.open goes nowhere.
    const webview = stage.createEl("webview", {
      cls: "terminus-agent-browser-page",
      attr: { partition: AGENT_BROWSER_PARTITION, src: "about:blank" },
    });
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    webview.addEventListener("dom-ready", () => this.onDomReady());
    webview.addEventListener("did-start-navigation", (e) => this.onStartNavigation(e as StartNavigationEvent));
    webview.addEventListener("did-navigate", (e) => this.onNavigated((e as NavigateEvent).url, false));
    webview.addEventListener("did-navigate-in-page", (e) => this.onNavigated((e as NavigateEvent).url, true));
    webview.addEventListener("page-title-updated", (e) => this.onTitle((e as TitleEvent).title));
    webview.addEventListener("did-fail-load", (e) => this.onFailLoad(e as FailLoadEvent));
    this.webview = webview;

    stage.createDiv({ cls: "terminus-agent-browser-edge" });
    this.driver.onActivity = (activity) => this.showActivity(activity);
    this.driver.onConsoleError = (message) => this.express("alarm", { doing: "Console error:", target: message });
    try {
      this.cursor = new AgentCursor(stage, this.state.ownerLabel ?? "Agent");
    } catch (err) {
      // Only decoration: the browser works the same without it.
      console.error("Terminus: couldn't draw the agent's cursor", err);
    }

    try {
      this.review = new ReviewLayer(this, this.browser, stage, body);
      this.review.onModeChange = () => this.renderReviewButtons();
      this.offReview = this.browser.review.onChange(() => this.renderReviewButtons());
    } catch (err) {
      console.error("Terminus: couldn't set up review mode", err);
    }
    this.registerDomEvent(contentEl, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.review?.handleEscape()) event.preventDefault();
    });

    this.renderStrip();
    this.renderReviewButtons();
  }

  private barButton(bar: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
    const button = bar.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": label } });
    setIcon(button, icon);
    setTooltip(button, label);
    button.addEventListener("click", onClick);
    return button;
  }

  private renderReviewButtons(): void {
    const review = this.review;
    const picking = review?.isPicking ?? false;
    this.reviewButton?.toggleClass("is-active", picking);
    this.reviewButton?.setAttr("aria-pressed", String(picking));
    this.reviewButton?.querySelector(".terminus-review-toggle-label")?.setText(picking ? "Reviewing" : "Review");
    const notes = review?.notesHere() ?? [];
    const waiting = notes.filter((n) => n.status === "fixed" || n.status === "answered").length;
    const open = notes.filter((n) => n.status !== "resolved").length;
    if (this.notesButton) {
      this.notesButton.toggleClass("is-active", review?.trayOpen ?? false);
      this.notesButton.dataset.count = open ? String(open) : "";
      this.notesButton.toggleClass("has-answers", waiting > 0);
      setTooltip(this.notesButton, waiting ? `Comments: ${waiting} to check` : open ? `Comments (${open})` : "Comments");
    }
  }

  async onClose(): Promise<void> {
    this.review?.dispose();
    this.review = null;
    this.offReview?.();
    this.offReview = null;
    window.clearTimeout(this.actingTimer);
    window.clearTimeout(this.sourceTimer);
    this.cursor?.dispose();
    this.driver.onActivity = null;
    this.driver.onConsoleError = null;
    this.driver.dispose();
    this.browser.viewClosed(this);
    this.page = null;
    this.webview = null;
  }

  /** The page, once the <webview> has attached. */
  whenReady(): Promise<GuestPage> {
    if (!this.ready) return Promise.reject(new Error("The browser view isn't open"));
    return this.ready;
  }

  /** Opens an address. Throws for one the agent browser doesn't allow. */
  async navigate(url: string): Promise<void> {
    if (!isAllowedBrowserUrl(url)) throw new Error(`The agent browser only opens pages on this computer, not ${url}`);
    this.state.url = url;
    this.noticeEl?.hide();
    this.renderStrip();
    const page = await this.whenReady();
    await page.loadURL(url).catch((err: unknown) => {
      // A load that's replaced by another one (or a redirect) rejects with
      // ERR_ABORTED; did-fail-load reports anything that really failed.
      // Electron words it either way: "ERR_ABORTED (-3)" or just "(-3)".
      if (!/ERR_ABORTED|\(-3\)/.test(String(err))) throw err;
    });
    if (!this.historyCleared) {
      page.clearHistory();
      this.historyCleared = true;
    }
  }

  /**
   * Reloads the page, brought up to date first. A plugin's site may serve a
   * copy it built from the vault, which an edit to the vault file doesn't
   * change, so the site is asked to refresh it (BrowserSite.refresh); and
   * one whose server restarted since is opened at its new address. A reload
   * asked for while one is running runs once that one is done, so a change
   * made meanwhile isn't missed. Throws, after reloading, with what the site
   * said when it couldn't bring the page up to date.
   */
  reloadPage(): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return this.reloading;
    }
    const run = async (): Promise<void> => {
      let problem: string | null = null;
      do {
        this.reloadAgain = false;
        problem = await this.reloadOnce();
      } while (this.reloadAgain);
      if (problem) throw new Error(problem);
    };
    this.reloading = run().finally(() => (this.reloading = null));
    return this.reloading;
  }

  private async reloadOnce(): Promise<string | null> {
    const page = await this.whenReady();
    const url = this.currentUrl();
    let problem: string | null = null;
    if (this.registeredSiteId && url && /^https?:/i.test(url)) {
      problem = await this.browser.refreshSitePage(this, url);
      const moved = await this.browser.movedSiteUrl(this, url);
      if (moved) {
        await this.navigate(moved);
        return problem;
      }
    }
    page.reload();
    return problem;
  }

  private async reloadReporting(): Promise<void> {
    try {
      await this.reloadPage();
    } catch (err) {
      new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  /** From AgentBrowser when a file the page is built from changes: reloads
   *  it once the writes have settled. */
  sourceChanged(source: string): void {
    window.clearTimeout(this.sourceTimer);
    const delay = /\.md$/i.test(source) ? NOTE_SETTLE_MS : SOURCE_SETTLE_MS;
    const fire = (): void => {
      if (this.review?.isComposing) {
        this.sourceTimer = window.setTimeout(fire, COMPOSING_RETRY_MS);
        return;
      }
      void this.reloadReporting();
    };
    this.sourceTimer = window.setTimeout(fire, delay);
  }

  /**
   * Runs an agent's click without taking the user's keyboard focus: a click
   * into the page moves focus to the <webview>, so whatever had it (the
   * agent's terminal, a note being typed in) gets it back. If the user had
   * already clicked into the page themselves, it stays there.
   */
  private async keepingFocus(action: () => Promise<void>): Promise<void> {
    const doc = this.contentEl.doc;
    const previous = doc.activeElement;
    try {
      await action();
    } finally {
      if (this.webview && doc.activeElement === this.webview && previous !== this.webview) {
        if (previous?.instanceOf(HTMLElement) && previous !== doc.body) previous.focus();
        else this.webview.blur();
      }
    }
  }

  /**
   * Whether the page is on screen. A <webview> in a background tab has no
   * size, and Electron never answers a screenshot of it.
   */
  isShown(): boolean {
    return (this.webview?.offsetWidth ?? 0) > 0 && (this.webview?.offsetHeight ?? 0) > 0;
  }

  private onDomReady(): void {
    if (this.page || !this.webview) return;
    const id = webContentsIdOf(this.webview);
    const page = id === null ? null : guestPageForWebContentsId(id);
    if (!page) return;
    // Keeps a prototype's timers and animations at full speed while it's
    // behind another tab, so what the agent sees matches what it would.
    page.setBackgroundThrottling(false);
    this.page = page;
    this.driver.attach(page);
    this.resolveReady?.(page);
  }

  /**
   * A page navigation the session refuses never reaches did-fail-load: it
   * starts and quietly stops, so a click on an outside link would look like
   * nothing happened. Says why instead.
   */
  private onStartNavigation(event: StartNavigationEvent): void {
    if (!event.isMainFrame || event.isInPlace) return;
    if (isAllowedBrowserUrl(event.url)) {
      this.noticeEl?.hide();
      return;
    }
    this.showNotice(`Didn't open ${event.url}: the agent browser only opens pages on this computer.`);
    this.express("sad", { doing: "Not allowed:", target: event.url });
  }

  private onNavigated(url: string, inPage: boolean): void {
    if (url === "about:blank" && this.state.url && this.state.url !== url) return;
    if (url !== "about:blank" && !inPage) {
      if (this.loadedOnce) this.express("wow");
      this.loadedOnce = true;
    }
    this.state.url = url;
    this.renderStrip();
    this.review?.pageChanged();
    this.renderReviewButtons();
    this.app.workspace.requestSaveLayout();
  }

  private onTitle(title: string): void {
    this.title = title;
    (this.leaf as { updateHeader?: () => void }).updateHeader?.();
  }

  private onFailLoad(event: FailLoadEvent): void {
    if (!event.isMainFrame || event.errorCode === ERR_ABORTED) return;
    const shown = this.browser.displayUrl(event.validatedURL, this);
    this.showNotice(`Couldn't open ${shown} (${event.errorDescription || event.errorCode}). Is the server running?`);
    this.express("sad", { doing: "Couldn't open", target: shown });
  }

  /** A face from the agent's companion for a moment that matters (see AgentCursor). */
  express(expression: Expression, say?: { doing: string; target: string }): void {
    // The companion is the agent's: a browser no agent has is the user's alone.
    if (!this.hasAgent()) return;
    this.cursor?.express(expression, say);
  }

  private hasAgent(): boolean {
    return this.ownerToken !== null || this.sharedWith.size > 0;
  }

  /** Shows what the agent just did: the edge while it's acting, and its
   *  cursor acting it out (see AgentCursor). */
  private showActivity(activity: BrowserActivity): void {
    if (!this.hasAgent()) return;
    const { contentEl } = this;
    contentEl.addClass("is-agent-acting");
    window.clearTimeout(this.actingTimer);
    this.actingTimer = window.setTimeout(() => {
      contentEl.removeClass("is-agent-acting");
      this.cursor?.rest();
    }, ACTING_MS);
    this.cursor?.show(activity);
  }

  private showNotice(text: string): void {
    this.noticeEl?.setText(text);
    this.noticeEl?.show();
  }

  /** After the user shares the browser with an agent. */
  refreshStrip(): void {
    this.renderStrip();
  }

  private renderStrip(): void {
    const color = this.browser.agentColor(this.ownerToken ?? [...this.sharedWith][0] ?? null);
    if (color) this.contentEl.style.setProperty("--terminus-agent-color", color);
    else this.contentEl.style.removeProperty("--terminus-agent-color");
    this.contentEl.toggleClass("has-agent", this.hasAgent());
    const owner = this.state.ownerLabel;
    const shared = [...this.sharedWith].map((token) => this.browser.terminalName(token));
    this.cursor?.setName(owner ?? shared[0] ?? "Agent");
    if (this.iconEl) setIcon(this.iconEl, owner || shared.length ? "bot" : "globe");
    // Only said when there's someone to name: a browser of the user's own needs no label.
    this.ownerEl?.setText(owner ? `Driven by ${owner}` : shared.length ? `Shared with ${shared.join(", ")}` : "");
    this.ownerEl?.toggle(Boolean(owner || shared.length));
    const url = this.state.url ?? "";
    const shown = this.browser.displayUrl(url, this);
    this.urlEl?.setText(shown);
    if (this.urlEl) setTooltip(this.urlEl, this.registeredSiteId ? shown : url);
  }
}
