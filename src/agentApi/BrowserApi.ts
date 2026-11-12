import type { WorkspaceLeaf } from "obsidian";
import {
  makeDirRecursive,
  osTempDir,
  pathIsAbsolute,
  pathJoin,
  pathRelative,
  pathResolve,
  realPathIfExists,
  writeFileBytes,
  type ConsoleLevel,
} from "terminus-node-bridge";
import type TerminusPlugin from "../main";
import type { AgentBrowserView } from "../browser/AgentBrowserView";
import { DriverError } from "../browser/BrowserDriver";
import { isAllowedBrowserUrl, isServableRelativePath, relativeStaysInside } from "../browser/policy";
import type { TerminalView } from "../views/TerminalView";
import { ApiError, RateLimiter, optionalBool, optionalChoice, optionalInt, optionalString, requireString, type Params } from "./policy";

/** How many browsers one agent may have open at once. */
const MAX_BROWSERS_PER_AGENT = 3;
/** Clicks, keys and snapshots come quickly; this only stops a runaway loop. */
const BROWSER_ACTION_LIMIT = 600;
const BROWSER_ACTION_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_WAIT_MS = 30_000;
const MAX_WAIT_MS = 100_000;
const WAIT_POLL_MS = 250;
const PLACEMENTS = ["tab", "split-right", "split-down"] as const;
const CONSOLE_LEVELS: ConsoleLevel[] = ["verbose", "info", "warning", "error"];

/** What BrowserApi needs from AgentApi. */
export interface BrowserApiHost {
  scope(caller: TerminalView): TerminalView[];
  /** Counts toward the opens/runs/prompts limit; throws when over it. */
  takeAction(caller: TerminalView): void;
}

/**
 * The agent API's `browser.*` methods: open a page on this computer, or a
 * prototype from the vault or the agent's own folder, in a browser view
 * beside the agent, and drive it -- snapshot, click, type, press, select,
 * wait, screenshot, read the console. See browser/ for the view, the
 * session's lock-down and the driver.
 *
 * Scoped like everything else here: an agent reaches the browsers that
 * agents in its own group opened. Behind its own setting, off by default.
 */
export class BrowserApi {
  private limiter = new RateLimiter(BROWSER_ACTION_LIMIT, BROWSER_ACTION_WINDOW_MS);

  constructor(
    private readonly plugin: TerminusPlugin,
    private readonly host: BrowserApiHost
  ) {}

  forget(token: string): void {
    this.limiter.forget(token);
  }

  async handle(caller: TerminalView, method: string, params: Params): Promise<unknown> {
    if (!this.plugin.settings.agentControl.browser) {
      throw new ApiError(
        "disabled",
        "The agent browser is off. The user can turn it on in Terminus settings → Agent control → Let agents use a browser.",
        403
      );
    }
    if (!this.plugin.agentBrowser.available()) {
      throw new ApiError("unavailable", "This version of Obsidian doesn't let plugins drive a browser view", 501);
    }
    try {
      return await this.dispatch(caller, method, params);
    } catch (err) {
      if (err instanceof DriverError) {
        const status = err.code === "stale_ref" ? 409 : err.code === "hidden" ? 409 : err.code === "timeout" ? 408 : 422;
        throw new ApiError(err.code, err.message, status);
      }
      throw err;
    }
  }

  private dispatch(caller: TerminalView, method: string, params: Params): unknown {
    switch (method) {
      case "browser.open":
        return this.open(caller, params);
      case "browser.list":
        return { browsers: this.reachable(caller).map((view) => this.describe(view)) };
      case "browser.navigate":
        return this.navigate(caller, params);
      case "browser.back":
        return this.act(caller, params, async (view) => {
          const page = await view.whenReady();
          if (!page.canGoBack()) throw new ApiError("invalid_params", "There's no page to go back to");
          page.goBack();
          await view.driver.waitForLoad();
        });
      case "browser.reload":
        return this.act(caller, params, async (view) => {
          (await view.whenReady()).reload();
          await view.driver.waitForLoad();
        });
      case "browser.snapshot":
        return this.snapshot(caller, params);
      case "browser.click":
        return this.act(caller, params, (view) => view.driver.click(requireString(params, "ref", 20), optionalBool(params, "double")));
      case "browser.type":
        return this.act(caller, params, (view) => {
          const text = params.text;
          if (typeof text !== "string") throw new ApiError("invalid_params", '"text" is required');
          if (text.length > 20000) throw new ApiError("invalid_params", '"text" is longer than 20000 characters');
          return view.driver.type(requireString(params, "ref", 20), text, optionalBool(params, "append"), optionalBool(params, "submit"));
        });
      case "browser.press":
        return this.act(caller, params, (view) => view.driver.press(requireString(params, "key", 40), optionalString(params, "ref", 20) ?? null));
      case "browser.select":
        return this.act(caller, params, async (view) => {
          const values = params.values;
          if (!Array.isArray(values) || values.length === 0 || !values.every((v): v is string => typeof v === "string")) {
            throw new ApiError("invalid_params", '"values" must be a list of option values or labels');
          }
          return { selected: await view.driver.select(requireString(params, "ref", 20), values) };
        });
      case "browser.wait":
        return this.wait(caller, params);
      case "browser.screenshot":
        return this.screenshot(caller, params);
      case "browser.console":
        return this.consoleMessages(caller, params);
      case "browser.close":
        return this.close(caller, params);
      default:
        throw new ApiError("unknown_method", `Unknown method "${method}"`, 404);
    }
  }

  // ---- Methods ----

  private async open(caller: TerminalView, params: Params): Promise<unknown> {
    const mine = this.plugin.agentBrowser.views().filter((view) => view.ownerToken === caller.hookToken);
    if (mine.length >= MAX_BROWSERS_PER_AGENT) {
      throw new ApiError("limit", `You already have ${mine.length} browsers open (the limit is ${MAX_BROWSERS_PER_AGENT}); close one first`, 429);
    }
    const target = await this.target(caller, params);
    this.host.takeAction(caller);
    this.takeBrowserAction(caller);
    const { workspace } = this.plugin.app;
    // Like a terminal an agent opens: the user stays where they were.
    const previous: WorkspaceLeaf | null = workspace.getMostRecentLeaf();
    let view: AgentBrowserView;
    try {
      view = await this.plugin.agentBrowser.open({
        url: target.url,
        siteId: target.siteId,
        ownerToken: caller.hookToken,
        ownerLabel: caller.getDisplayText(),
        placement: optionalChoice(params, "placement", PLACEMENTS, "split-right"),
        near: caller.leaf,
      });
    } catch (err) {
      if (target.siteId) this.plugin.agentBrowser.sites.revoke(target.siteId);
      throw new ApiError("unavailable", err instanceof Error ? err.message : String(err), 500);
    } finally {
      if (previous) workspace.setActiveLeaf(previous, { focus: true });
    }
    await view.driver.waitForLoad().catch(() => undefined);
    return this.describe(view);
  }

  private async navigate(caller: TerminalView, params: Params): Promise<unknown> {
    const view = this.view(caller, params);
    this.takeBrowserAction(caller);
    const target = await this.target(caller, params);
    if (target.siteId) view.servedSiteIds.add(target.siteId);
    try {
      await view.navigate(target.url);
    } catch (err) {
      throw new ApiError("page_error", err instanceof Error ? err.message : String(err), 422);
    }
    await view.driver.waitForLoad();
    return this.describe(view);
  }

  private async snapshot(caller: TerminalView, params: Params): Promise<unknown> {
    const view = this.view(caller, params);
    this.takeBrowserAction(caller);
    await view.whenReady();
    const snapshot = await view.driver.snapshot();
    return { ...this.describe(view), snapshot: snapshot.text, truncated: snapshot.truncated };
  }

  /** An action on the page, answered with where the page is now (and a
   *  fresh snapshot with `snapshot: true`). */
  private async act(caller: TerminalView, params: Params, action: (view: AgentBrowserView) => Promise<unknown>): Promise<unknown> {
    const view = this.view(caller, params);
    this.takeBrowserAction(caller);
    await view.whenReady();
    let extra: unknown;
    try {
      extra = await action(view);
    } catch (err) {
      // The companion is cross when an action is refused.
      if (err instanceof DriverError && err.code !== "page_error") {
        view.express("cross", { doing: "Can't:", target: err.message.replace(/^Can't (use|click|focus) e\d+: /, "") });
      }
      throw err;
    }
    const result: Record<string, unknown> = { ...this.describe(view), ...(typeof extra === "object" && extra !== null ? extra : {}) };
    if (optionalBool(params, "snapshot")) result.snapshot = (await view.driver.snapshot()).text;
    return result;
  }

  private async wait(caller: TerminalView, params: Params): Promise<unknown> {
    const view = this.view(caller, params);
    const text = optionalString(params, "text", 1000);
    const gone = optionalString(params, "gone", 1000);
    if (text === undefined && gone === undefined) throw new ApiError("invalid_params", 'Give "text" to wait for, or "gone" to wait until it disappears');
    const timeout = optionalInt(params, "timeout_ms", DEFAULT_WAIT_MS, 500, MAX_WAIT_MS);
    this.takeBrowserAction(caller);
    await view.whenReady();
    const until = Date.now() + timeout;
    for (;;) {
      if (!this.plugin.agentBrowser.views().includes(view)) throw new ApiError("closed", `${view.publicId} was closed`, 410);
      const body = await view.driver.bodyText();
      if ((text === undefined || body.includes(text)) && (gone === undefined || !body.includes(gone))) {
        view.express("love", text !== undefined ? { doing: "Found", target: `"${text}"` } : { doing: "Gone:", target: `"${gone}"` });
        return this.describe(view);
      }
      if (Date.now() >= until) {
        const what = text !== undefined ? `"${text}" to appear` : `"${gone}" to go`;
        throw new ApiError("timeout", `Waited ${Math.round(timeout / 1000)}s for ${what} on ${view.publicId}; call again to keep waiting`, 408);
      }
      await new Promise((resolve) => window.setTimeout(resolve, WAIT_POLL_MS));
    }
  }

  private async screenshot(caller: TerminalView, params: Params): Promise<unknown> {
    const view = this.view(caller, params);
    this.takeBrowserAction(caller);
    await view.whenReady();
    const png = await view.driver.screenshot(view.isShown());
    view.express("cool");
    const folder = pathJoin(osTempDir(), "terminus-browser");
    await makeDirRecursive(folder);
    const path = pathJoin(folder, `${view.publicId}-${Date.now()}.png`);
    await writeFileBytes(path, png);
    return { ...this.describe(view), path, bytes: png.length };
  }

  private consoleMessages(caller: TerminalView, params: Params): unknown {
    const view = this.view(caller, params);
    const level = optionalChoice(params, "level", CONSOLE_LEVELS, "verbose");
    const levels = CONSOLE_LEVELS.slice(CONSOLE_LEVELS.indexOf(level));
    const messages = view.driver.takeConsole(levels).map((entry) => ({ level: entry.level, text: entry.text, source: entry.source }));
    return { id: view.publicId, messages };
  }

  private close(caller: TerminalView, params: Params): unknown {
    const view = this.view(caller, params);
    if (view.ownerToken !== caller.hookToken) {
      throw new ApiError("forbidden", `${view.publicId} wasn't opened by you; only the agent that opened it, or the user, can close it`, 403);
    }
    view.leaf.detach();
    return { id: view.publicId, closed: true };
  }

  // ---- Shared ----

  /** Browsers opened by agents in the caller's group. */
  private reachable(caller: TerminalView): AgentBrowserView[] {
    const tokens = new Set(this.host.scope(caller).map((view) => view.hookToken));
    return this.plugin.agentBrowser.views().filter((view) => view.ownerToken !== null && tokens.has(view.ownerToken));
  }

  private view(caller: TerminalView, params: Params): AgentBrowserView {
    const id = requireString(params, "id", 20);
    const view = this.reachable(caller).find((v) => v.publicId === id);
    if (!view) throw new ApiError("not_found", `No browser ${id} in your group. "browser list" shows the ones you can reach.`, 404);
    return view;
  }

  private describe(view: AgentBrowserView): Record<string, unknown> {
    let url = "";
    let title = "";
    try {
      ({ url, title } = view.driver.summary());
    } catch {
      // Not attached yet.
    }
    const owner = view.ownerToken ? this.plugin.findTerminalView(view.ownerToken) : null;
    return {
      id: view.publicId,
      url,
      shown_as: this.plugin.agentBrowser.displayUrl(url),
      title,
      visible: view.isShown(),
      opened_by: owner?.publicId ?? null,
    };
  }

  /**
   * The address to open, from `url` (a page on this computer) or `path` (a
   * file or folder in the vault or the caller's working folder, served over
   * http). A relative path is taken from the caller's working folder.
   */
  private async target(caller: TerminalView, params: Params): Promise<{ url: string; siteId?: string }> {
    const url = optionalString(params, "url", 4000);
    const path = optionalString(params, "path", 2000);
    if ((url === undefined) === (path === undefined)) throw new ApiError("invalid_params", 'Give either "url" or "path"');
    if (url !== undefined) {
      if (!isAllowedBrowserUrl(url)) {
        throw new ApiError("forbidden", `The agent browser only opens pages on this computer (localhost, 127.0.0.1), not ${url}`, 403);
      }
      return { url };
    }

    const vault = this.plugin.getVaultBasePath();
    const cwd = this.plugin.agentSessionStore.get(caller.hookToken)?.cwd ?? caller.shellCwd ?? vault;
    const absolute = pathIsAbsolute(path!) ? path! : pathResolve(cwd, path!);
    const real = await realPathIfExists(absolute);
    if (!real) throw new ApiError("not_found", `Nothing at ${absolute}`, 404);
    const roots = (await Promise.all([vault, cwd].map((root) => realPathIfExists(root)))).filter((root): root is string => root !== null);
    const inside = roots.map((root) => pathRelative(root, real)).filter((relative) => relative === "" || relativeStaysInside(relative));
    if (inside.length === 0) {
      throw new ApiError("forbidden", `Only files in the vault or your working folder (${cwd}) can be opened, not ${absolute}`, 403);
    }
    if (!inside.some((relative) => relative === "" || isServableRelativePath(relative))) {
      throw new ApiError("forbidden", `Files under a dot-folder, or dotfiles, aren't opened: ${absolute}`, 403);
    }
    try {
      return await this.plugin.agentBrowser.serve(real, caller.hookToken);
    } catch (err) {
      throw new ApiError("invalid_params", err instanceof Error ? err.message : String(err));
    }
  }

  private takeBrowserAction(caller: TerminalView): void {
    if (!this.limiter.take(caller.hookToken)) {
      throw new ApiError("rate_limited", `Too many browser actions: at most ${BROWSER_ACTION_LIMIT} per 10 minutes`, 429);
    }
  }
}
