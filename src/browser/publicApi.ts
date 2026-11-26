import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";
import type TerminusPlugin from "../main";
import type { BrowserPlacement } from "./AgentBrowser";
import { isAllowedBrowserUrl } from "./policy";
import type { BrowserSite } from "./sites";

/** The workspace event Terminus fires once its API is ready, so a plugin
 *  that loaded first can register then. */
export const TERMINUS_API_READY_EVENT = "terminus:api-ready";

/**
 * What other plugins may call, as `app.plugins.getPlugin("terminus")?.api`.
 * Feature-detect it: Terminus may be missing, off, or older. Every method
 * works whether or not the user lets agents use the browser; that setting
 * only governs agents.
 *
 *   const api = app.plugins.getPlugin("terminus")?.api;
 *   if (api?.version >= 1) {
 *     const unregister = api.registerSite({ id: "my-preview", name: "My preview", open: async () => url });
 *     this.register(unregister);
 *   }
 */
export interface TerminusApi {
  readonly version: 1;
  /** False when this Obsidian doesn't let plugins show the browser. */
  browserAvailable(): boolean;
  /**
   * Offers a local site to the Terminus browser: the user can open it from
   * the "Open a local page in the browser" command, and agents (when the user lets
   * them use the browser) with `browser open --site <id>`. The address
   * open() returns is never shown to agents. Returns a function that
   * removes it; call that when your plugin unloads.
   */
  registerSite(site: BrowserSite): () => void;
  /** Opens a registered site, or a page on this computer, in a Terminus
   *  browser tab, for the user. */
  openInBrowser(target: { siteId: string } | { url: string }, options?: { placement?: BrowserPlacement }): Promise<void>;
}

export function createTerminusApi(plugin: TerminusPlugin): TerminusApi {
  return Object.freeze({
    version: 1 as const,
    browserAvailable: () => plugin.agentBrowser.available(),
    registerSite: (site: BrowserSite) => plugin.agentBrowser.registry.register(site),
    openInBrowser: async (target: { siteId: string } | { url: string }, options?: { placement?: BrowserPlacement }) => {
      if (typeof target !== "object" || target === null) throw new Error("openInBrowser needs { siteId } or { url }");
      const placement = options?.placement ?? "tab";
      if ("siteId" in target && typeof target.siteId === "string") {
        await plugin.agentBrowser.openForUser({ siteId: target.siteId }, placement);
      } else if ("url" in target && typeof target.url === "string") {
        await plugin.agentBrowser.openForUser({ url: target.url }, placement);
      } else {
        throw new Error("openInBrowser needs { siteId } or { url }");
      }
    },
  });
}

type Choice = { kind: "site"; site: BrowserSite } | { kind: "url" };

/** "Open in Terminus browser": the registered sites, and an address to type. */
export class OpenInBrowserModal extends SuggestModal<Choice> {
  constructor(
    app: App,
    private readonly plugin: TerminusPlugin
  ) {
    super(app);
    this.setPlaceholder("Open a site from your plugins, or a localhost address");
  }

  getSuggestions(query: string): Choice[] {
    const q = query.trim().toLowerCase();
    const sites: Choice[] = this.plugin.agentBrowser.registry
      .list()
      .filter((site) => !q || site.name.toLowerCase().includes(q) || site.id.includes(q))
      .map((site) => ({ kind: "site", site }));
    return [...sites, { kind: "url" }];
  }

  renderSuggestion(choice: Choice, el: HTMLElement): void {
    if (choice.kind === "site") {
      el.createDiv({ text: choice.site.name });
      if (choice.site.description) el.createEl("small", { text: choice.site.description, cls: "terminus-browser-muted" });
    } else {
      el.createDiv({ text: "Open a page on this computer…" });
      el.createEl("small", { text: "Such as http://localhost:5173 from a dev server", cls: "terminus-browser-muted" });
    }
  }

  onChooseSuggestion(choice: Choice): void {
    if (choice.kind === "url") {
      new UrlModal(this.app, (url) => void openReporting(this.plugin, { url })).open();
      return;
    }
    void openReporting(this.plugin, { siteId: choice.site.id });
  }
}

async function openReporting(plugin: TerminusPlugin, target: { siteId: string } | { url: string }): Promise<void> {
  try {
    await plugin.agentBrowser.openForUser(target);
  } catch (err) {
    new Notice(`Terminus: ${err instanceof Error ? err.message : String(err)}`, 8000);
  }
}

class UrlModal extends Modal {
  private value = "http://localhost:";
  private input: HTMLInputElement | null = null;

  constructor(
    app: App,
    private readonly onSubmit: (url: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Open in Terminus browser");
    this.contentEl.createEl("p", {
      text: "The Terminus browser opens pages on this computer only (localhost, 127.0.0.1).",
      cls: "terminus-browser-muted",
    });
    new Setting(this.contentEl).setName("Address").addText((text) => {
      this.input = text.inputEl;
      text.setValue(this.value).onChange((value) => (this.value = value));
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.submit();
        }
      });
    });
    new Setting(this.contentEl).addButton((button) => button.setButtonText("Open").setCta().onClick(() => this.submit()));
    window.setTimeout(() => this.input?.focus(), 0);
  }

  private submit(): void {
    let url = this.value.trim();
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) url = `http://${url}`;
    if (!isAllowedBrowserUrl(url) || url === "about:blank") {
      new Notice("Terminus: the browser only opens pages on this computer, such as http://localhost:5173");
      return;
    }
    this.close();
    this.onSubmit(url);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
