import type { WorkspaceLeaf } from "obsidian";
import {
  pathRelative,
  configureBrowserSession,
  fileKind,
  isElectronRemoteAvailable,
  makeDirRecursive,
  osTempDir,
  pathBasename,
  pathDirname,
  pathJoin,
  writeFileBytes,
} from "terminus-node-bridge";
import type TerminusPlugin from "../main";
import { AGENT_BROWSER_PARTITION, AGENT_BROWSER_VIEW_TYPE, AgentBrowserView } from "./AgentBrowserView";
import { isAllowedBrowserUrl, parseServeRequest } from "./policy";
import { ReviewBook, composeReviewPrompt, siteOfPageKey, type ReviewNote } from "./review";
import { BrowserSiteRegistry, withoutQuery } from "./sites";
import { StaticSites } from "./StaticSites";

export type BrowserPlacement = "tab" | "split-right" | "split-down";

export interface OpenBrowserSpec {
  url: string;
  /** The agent's terminal (hook token); absent when the user opened it. */
  ownerToken?: string;
  ownerLabel?: string;
  placement: BrowserPlacement;
  /** Opens beside this leaf (the agent's terminal) rather than the active one. */
  near?: WorkspaceLeaf;
  /** A folder served for this view; stopped when the view closes. */
  siteId?: string;
  /** The registered site it opens (see sites.ts), whose first address is
   *  never shown because it may carry the site's token. */
  registeredSiteId?: string;
  /** False to open it in the background. */
  focus?: boolean;
}

/**
 * The agent browser: browser views agents can drive, the locked-down
 * session they share, and the folders served for them. Local only: a view
 * opens pages on this computer (localhost, 127.0.0.1, [::1]) and nothing
 * else, enforced by the session for every page and frame load, redirects
 * included, not just by the view.
 */
export class AgentBrowser {
  readonly sites: StaticSites;
  /** Local sites other plugins offer (see sites.ts and TerminusApi). */
  readonly registry = new BrowserSiteRegistry();
  /** Review notes for the Obsidian session (see review.ts). */
  readonly review = new ReviewBook();
  private sessionPrepared = false;
  private nextId = 1;

  constructor(private readonly plugin: TerminusPlugin) {
    this.sites = new StaticSites(() => plugin.reviewServer.getPort());
  }

  /** Called once from onload. */
  register(): void {
    this.plugin.registerView(AGENT_BROWSER_VIEW_TYPE, (leaf) => new AgentBrowserView(leaf, this));
    this.plugin.reviewServer.setStaticHandler((req, res) => this.sites.handle(req, res));
    // A view restored from the last run has no agent and no served folder.
    this.plugin.app.workspace.onLayoutReady(() => {
      for (const leaf of this.plugin.app.workspace.getLeavesOfType(AGENT_BROWSER_VIEW_TYPE)) leaf.detach();
    });
  }

  /** Called from onunload. */
  unload(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(AGENT_BROWSER_VIEW_TYPE)) leaf.detach();
    this.sites.clear();
    this.registry.clear();
    this.plugin.reviewServer.setStaticHandler(null);
  }

  /** False when this Obsidian doesn't give plugins the Electron access the
   *  browser needs. */
  available(): boolean {
    return isElectronRemoteAvailable();
  }

  /** Locks the session down before its first page loads. */
  prepareSession(): void {
    if (this.sessionPrepared) return;
    configureBrowserSession(AGENT_BROWSER_PARTITION, { allowNavigation: isAllowedBrowserUrl });
    this.sessionPrepared = true;
  }

  views(): AgentBrowserView[] {
    return this.plugin.app.workspace
      .getLeavesOfType(AGENT_BROWSER_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is AgentBrowserView => view instanceof AgentBrowserView);
  }

  /**
   * Serves a file's folder (or a folder) and returns the address to open:
   * the file itself, or the folder's index.html. Which folders an agent may
   * serve is the caller's decision; this serves whatever it's given.
   */
  async serve(path: string, ownerToken: string): Promise<{ url: string; siteId: string }> {
    const kind = await fileKind(path);
    if (kind === null) throw new Error(`Nothing at ${path}`);
    const folder = kind === "directory" ? path : pathDirname(path);
    const site = await this.sites.serve(folder, ownerToken);
    const entry = kind === "directory" ? "" : encodeURIComponent(pathBasename(path));
    return { url: site.baseUrl + entry, siteId: site.id };
  }

  async open(spec: OpenBrowserSpec): Promise<AgentBrowserView> {
    if (!this.available()) throw new Error("This version of Obsidian doesn't let plugins drive a browser view");
    if (!isAllowedBrowserUrl(spec.url)) throw new Error(`The agent browser only opens pages on this computer, not ${spec.url}`);
    this.prepareSession();
    const { workspace } = this.plugin.app;
    if (spec.near) workspace.setActiveLeaf(spec.near, { focus: false });
    const leaf =
      spec.placement === "tab"
        ? workspace.getLeaf("tab")
        : workspace.getLeaf("split", spec.placement === "split-down" ? "horizontal" : "vertical");
    await leaf.setViewState({
      type: AGENT_BROWSER_VIEW_TYPE,
      active: spec.focus === true,
      state: { ownerToken: spec.ownerToken, ownerLabel: spec.ownerLabel },
    });
    const view = leaf.view;
    if (!(view instanceof AgentBrowserView)) {
      leaf.detach();
      throw new Error("The browser view couldn't be opened");
    }
    view.publicId = `b${this.nextId++}`;
    if (spec.siteId) view.servedSiteIds.add(spec.siteId);
    if (spec.registeredSiteId) {
      view.registeredSiteId = spec.registeredSiteId;
      view.secretUrl = spec.url;
    }
    await view.navigate(spec.url);
    if (spec.focus) await workspace.revealLeaf(leaf);
    return view;
  }

  /**
   * The address a registered site opens at, from the plugin that offers it.
   * Throws with the plugin's own message when it can't be opened.
   */
  async siteUrl(id: string): Promise<string> {
    const site = this.registry.get(id);
    if (!site) throw new Error(`No site "${id}". The plugin that offers it may be off.`);
    // The plugin's own message, said as the site's: "Build a preview first".
    const opened = await Promise.resolve()
      .then(() => site.open())
      .then(
        (value): { url: unknown } => ({ url: value }),
        (err: unknown): { error: string } => ({ error: err instanceof Error ? err.message : String(err) })
      );
    if ("error" in opened) throw new Error(`${site.name}: ${opened.error}`);
    const url = opened.url;
    if (typeof url !== "string" || !isAllowedBrowserUrl(url) || url === "about:blank") {
      throw new Error(`${site.name} didn't give an address on this computer to open`);
    }
    return url;
  }

  /** The user opening a page or a registered site themselves: not an
   *  agent's, so no agent can reach it until the user sends it notes. */
  async openForUser(target: { url: string } | { siteId: string }, placement: BrowserPlacement = "tab"): Promise<AgentBrowserView> {
    if ("siteId" in target) {
      const url = await this.siteUrl(target.siteId);
      return this.open({ url, registeredSiteId: target.siteId, placement, focus: true });
    }
    return this.open({ url: target.url, placement, focus: true });
  }

  /** Closes the browsers agents opened: when the user turns the browser or
   *  agent control off. Browsers the user opened stay, and agents lose the
   *  access to them that review notes gave. */
  closeAgentBrowsers(): void {
    for (const view of this.views()) {
      if (view.ownerToken) view.leaf.detach();
      else view.sharedWith.clear();
    }
  }

  /**
   * Which page a review note belongs to: the served folder and the path in
   * it for a prototype, the registered site and path for a plugin's site
   * (its port and token change between runs), or the address without its
   * query otherwise.
   */
  pageKey(view: AgentBrowserView, url: string): string {
    const served = this.servedFile(view, url);
    if (served) return `file:${served.root}/${served.relative}`;
    if (view.registeredSiteId) {
      try {
        return `site:${view.registeredSiteId}:${new URL(url).pathname}`;
      } catch {
        // Fall through.
      }
    }
    return withoutQuery(url);
  }

  /** The file a page was built from, when Terminus can tell: the file
   *  itself for a served folder, or what the registered site says. */
  sourceFor(view: AgentBrowserView, url: string): string | null {
    const served = this.servedFile(view, url);
    if (served) return pathJoin(served.root, served.relative);
    if (view.registeredSiteId) {
      const site = this.registry.get(view.registeredSiteId);
      try {
        const source = site?.sourceFor?.(url);
        if (typeof source === "string" && source) return pathJoin(this.plugin.getVaultBasePath(), source);
      } catch {
        // The site doesn't know; the note goes without a file.
      }
    }
    return null;
  }

  private servedFile(view: AgentBrowserView, url: string): { root: string; relative: string } | null {
    let path: string;
    try {
      path = new URL(url).pathname;
    } catch {
      return null;
    }
    const request = parseServeRequest(path);
    if (request.kind !== "file" || !view.servedSiteIds.has(request.siteId)) return null;
    const site = this.sites.get(request.siteId);
    if (!site) return null;
    const relative = request.wantsDirectory ? [...request.segments, "index.html"].join("/") : request.segments.join("/");
    return { root: site.root, relative };
  }

  // ---- Sending review notes ----

  /** A terminal's name, for "Waiting on …". */
  terminalName(token: string | null): string {
    return (token && this.plugin.findTerminalView(token)?.getDisplayText()) || "the agent";
  }

  /**
   * The Claude sessions review notes can go to: the agent that opened the
   * browser first, then ones it was shared with, then every other running
   * session, in workspace order.
   */
  reviewTargets(view: AgentBrowserView): { token: string; label: string; reason: string }[] {
    const running = this.plugin.groups
      .terminals()
      .filter((terminal) => this.plugin.agentSessionStore.get(terminal.hookToken)?.running);
    const rank = (token: string): number => (token === view.ownerToken ? 0 : view.sharedWith.has(token) ? 1 : 2);
    return running
      .map((terminal) => ({
        token: terminal.hookToken,
        label: terminal.getDisplayText(),
        reason: rank(terminal.hookToken) === 0 ? "Opened this browser" : rank(terminal.hookToken) === 1 ? "Has your earlier notes" : "",
      }))
      .sort((a, b) => rank(a.token) - rank(b.token));
  }

  /** Whether an agent can answer notes in the browser itself. */
  agentsCanReply(): boolean {
    return this.plugin.agentControlActive && this.plugin.settings.agentControl.browser && this.available();
  }

  reviewPrompt(view: AgentBrowserView, notes: ReviewNote[], canReply: boolean): string {
    const vault = this.plugin.getVaultBasePath();
    const url = view.currentUrl();
    const site = url ? siteOfPageKey(this.pageKey(view, url)) : null;
    const standingKeeps = this.review
      .all()
      .filter((note) => note.intent === "keep" && note.status !== "open" && site !== null && siteOfPageKey(note.pageKey) === site);
    return composeReviewPrompt(notes, {
      standingKeeps,
      browserId: canReply ? view.publicId : null,
      canReply,
      showPath: (path) => {
        const relative = pathRelative(vault, path);
        return relative && !relative.startsWith("..") ? relative : path;
      },
    });
  }

  /**
   * Sends open notes to a Claude session, queued so they arrive between its
   * turns, and lets that session reach this browser to check its work and
   * answer them. Returns what happened, for a notice.
   */
  sendReview(view: AgentBrowserView, notes: ReviewNote[], token: string): string {
    const open = notes.filter((note) => note.status === "open");
    if (open.length === 0) throw new Error("There are no new notes to send");
    const canReply = this.agentsCanReply();
    const name = this.terminalName(token);
    if (!this.plugin.queueGuidance(token, this.reviewPrompt(view, open, canReply))) {
      throw new Error(`Couldn't send to ${name}: its Claude session isn't running`);
    }
    if (canReply) view.sharedWith.add(token);
    view.refreshStrip();
    this.review.markSent(
      open.map((note) => note.id),
      token
    );
    const count = open.length === 1 ? "1 note" : `${open.length} notes`;
    const busy = this.plugin.agentSessionStore.get(token)?.status === "working";
    return busy ? `${count} queued for ${name}; it gets them when its turn ends` : `Sent ${count} to ${name}`;
  }

  /**
   * Sends open notes to a new Claude session in a new terminal: typed in
   * there for the user to send, and the browser shared with it so it can
   * answer and check its work, as with a session already running.
   */
  async sendReviewToNewSession(view: AgentBrowserView, notes: ReviewNote[]): Promise<string> {
    const open = notes.filter((note) => note.status === "open");
    if (open.length === 0) throw new Error("There are no new notes to send");
    const canReply = this.agentsCanReply();
    const name = `Review · ${view.getDisplayText()}`.slice(0, 48);
    const terminal = await this.plugin.startClaudeWith(this.reviewPrompt(view, open, canReply), name);
    if (!terminal) throw new Error("Couldn't open a new terminal");
    if (canReply) view.sharedWith.add(terminal.hookToken);
    view.refreshStrip();
    this.review.markSent(
      open.map((note) => note.id),
      terminal.hookToken
    );
    return `started ${terminal.getDisplayText()} with your ${open.length === 1 ? "comment" : "comments"} typed in. Press Enter to send.`;
  }

  /** Saves a picked element's image where the agent can Read it. */
  async saveReviewImage(noteKey: string, png: Uint8Array): Promise<string> {
    const folder = pathJoin(osTempDir(), "terminus-browser");
    await makeDirRecursive(folder);
    const path = pathJoin(folder, `review-${noteKey}-${Date.now()}.png`);
    await writeFileBytes(path, png);
    return path;
  }

  /** The colour of the agent's group, as a CSS value, or null when it has none. */
  agentColor(ownerToken: string | null): string | null {
    const terminal = ownerToken ? this.plugin.findTerminalView(ownerToken) : null;
    const group = terminal?.groupId ? this.plugin.groupStore.get(terminal.groupId) : undefined;
    return group?.color || null;
  }

  /** From the view as it closes. */
  viewClosed(view: AgentBrowserView): void {
    for (const id of view.servedSiteIds) this.sites.revoke(id);
    view.servedSiteIds.clear();
  }

  /** A served address as the folder's name and the path below it, rather
   *  than the random id it's served at. */
  displayUrl(url: string, view?: AgentBrowserView): string {
    // A registered site's first address may carry its token.
    if (view?.registeredSiteId) {
      const site = this.registry.get(view.registeredSiteId);
      const shown = withoutQuery(url);
      return site ? `${site.name} · ${safePath(shown)}` : shown;
    }
    for (const view of this.views()) {
      for (const id of view.servedSiteIds) {
        const site = this.sites.get(id);
        if (site && url.startsWith(site.baseUrl)) {
          return `${pathBasename(site.root)}/${safeDecode(url.slice(site.baseUrl.length).split(/[?#]/, 1)[0] ?? "")}`;
        }
      }
    }
    return url;
  }
}

function safePath(url: string): string {
  try {
    return safeDecode(new URL(url).pathname);
  } catch {
    return url;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
