import type { WorkspaceLeaf } from "obsidian";
import { configureBrowserSession, fileKind, isElectronRemoteAvailable, pathBasename, pathDirname } from "terminus-node-bridge";
import type TerminusPlugin from "../main";
import { AGENT_BROWSER_PARTITION, AGENT_BROWSER_VIEW_TYPE, AgentBrowserView } from "./AgentBrowserView";
import { isAllowedBrowserUrl } from "./policy";
import { StaticSites } from "./StaticSites";

export type BrowserPlacement = "tab" | "split-right" | "split-down";

export interface OpenBrowserSpec {
  url: string;
  ownerToken: string;
  ownerLabel: string;
  placement: BrowserPlacement;
  /** Opens beside this leaf (the agent's terminal) rather than the active one. */
  near?: WorkspaceLeaf;
  /** A folder served for this view; stopped when the view closes. */
  siteId?: string;
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
      active: false,
      state: { ownerToken: spec.ownerToken, ownerLabel: spec.ownerLabel },
    });
    const view = leaf.view;
    if (!(view instanceof AgentBrowserView)) {
      leaf.detach();
      throw new Error("The browser view couldn't be opened");
    }
    view.publicId = `b${this.nextId++}`;
    if (spec.siteId) view.servedSiteIds.add(spec.siteId);
    await view.navigate(spec.url);
    return view;
  }

  /** Closes every agent browser: when the user turns the browser or agent
   *  control off. */
  closeAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType(AGENT_BROWSER_VIEW_TYPE)) leaf.detach();
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
  displayUrl(url: string): string {
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

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
