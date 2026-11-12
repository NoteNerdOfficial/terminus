import { ItemView, setIcon, setTooltip, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { guestPageForWebContentsId, webContentsIdOf, type GuestPage } from "terminus-node-bridge";
import { AgentCursor, type Expression } from "./agentCursor";
import { BrowserDriver, type BrowserActivity } from "./BrowserDriver";
import { isAllowedBrowserUrl } from "./policy";
import type { AgentBrowser } from "./AgentBrowser";

export const AGENT_BROWSER_VIEW_TYPE = "terminus-agent-browser";

/** Its own session, in memory only: nothing the agent's pages store
 *  (cookies, localStorage) survives a restart, and none of it is shared
 *  with Obsidian's Web viewer, where the user may be signed in to things. */
export const AGENT_BROWSER_PARTITION = "terminus-agent-browser";

const ERR_ABORTED = -3;
/** How long the edge and the cursor's bubble stay after the last action. */
const ACTING_MS = 2500;

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
  private cursor: AgentCursor | null = null;
  private actingTimer = 0;
  /** Folders served for this view, stopped when it closes. */
  readonly servedSiteIds = new Set<string>();
  /** What agents drive the page through. */
  readonly driver = new BrowserDriver((action) => this.keepingFocus(action));
  /** What agents call it (`b1`); given by AgentBrowser when it opens. */
  publicId = "";

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
    return this.title || "Agent browser";
  }

  getIcon(): string {
    return "globe";
  }

  get ownerToken(): string | null {
    return this.state.ownerToken ?? null;
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
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
    setIcon(bar.createSpan({ cls: "terminus-agent-browser-icon" }), "bot");
    this.ownerEl = bar.createSpan({ cls: "terminus-agent-browser-owner" });
    this.urlEl = bar.createSpan({ cls: "terminus-agent-browser-url" });
    const reload = bar.createEl("button", { cls: "clickable-icon terminus-agent-browser-reload" });
    setIcon(reload, "rotate-cw");
    setTooltip(reload, "Reload");
    reload.addEventListener("click", () => this.page?.reload());
    this.noticeEl = contentEl.createDiv({ cls: "terminus-agent-browser-notice" });
    this.noticeEl.hide();

    // The page, with the agent's edge, ripples and cursor laid over it. The
    // overlays take no pointer events, so they never get in the user's way.
    const stage = contentEl.createDiv({ cls: "terminus-agent-browser-stage" });

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

    this.renderStrip();
  }

  async onClose(): Promise<void> {
    window.clearTimeout(this.actingTimer);
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
      if (!String(err).includes("ERR_ABORTED")) throw err;
    });
    if (!this.historyCleared) {
      page.clearHistory();
      this.historyCleared = true;
    }
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
    this.app.workspace.requestSaveLayout();
  }

  private onTitle(title: string): void {
    this.title = title;
    (this.leaf as { updateHeader?: () => void }).updateHeader?.();
  }

  private onFailLoad(event: FailLoadEvent): void {
    if (!event.isMainFrame || event.errorCode === ERR_ABORTED) return;
    this.showNotice(`Couldn't open ${event.validatedURL} (${event.errorDescription || event.errorCode}). Is the server running?`);
    this.express("sad", { doing: "Couldn't open", target: this.browser.displayUrl(event.validatedURL) });
  }

  /** A face from the agent's companion for a moment that matters (see AgentCursor). */
  express(expression: Expression, say?: { doing: string; target: string }): void {
    this.cursor?.express(expression, say);
  }

  /** Shows what the agent just did: the edge while it's acting, and its
   *  cursor acting it out (see AgentCursor). */
  private showActivity(activity: BrowserActivity): void {
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

  private renderStrip(): void {
    const color = this.browser.agentColor(this.ownerToken);
    if (color) this.contentEl.style.setProperty("--terminus-agent-color", color);
    else this.contentEl.style.removeProperty("--terminus-agent-color");
    const owner = this.state.ownerLabel;
    this.cursor?.setName(owner ?? "Agent");
    this.ownerEl?.setText(owner ? `Driven by ${owner}` : "Agent browser");
    const url = this.state.url ?? "";
    this.urlEl?.setText(this.browser.displayUrl(url));
    if (this.urlEl) setTooltip(this.urlEl, url);
  }
}
