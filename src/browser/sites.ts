/**
 * Local sites other plugins offer to the Terminus browser.
 *
 * A plugin that serves something on this computer, such as a preview, often
 * guards it with a token it keeps to itself, so an agent that finds the port
 * still can't open it. The plugin registers the site here instead, with a
 * function that starts whatever serves it and returns the address to open,
 * token and all. Terminus calls that function only when the user or an
 * agent opens the site, and never shows the address it returns: agents see
 * the site's id and the page they end up on.
 *
 * Nothing here needs Obsidian, so it can be tested on its own.
 */

/** What a plugin registers. See TerminusApi.registerSite. */
export interface BrowserSite {
  /** Stable, lowercase: letters, digits and dashes, e.g. "vault-publisher-preview". */
  id: string;
  /** Shown to the user and to agents, e.g. "Vault Publisher preview". */
  name: string;
  /** One line on what it is, for agents choosing between sites. */
  description?: string;
  /**
   * Starts whatever serves the site if it isn't running and returns the
   * address to open. It must be a page on this computer (localhost,
   * 127.0.0.1 or [::1]). Throw with a message the user can act on, such as
   * "Build a preview first".
   */
  open(): Promise<string>;
  /**
   * Optional: the vault path of the file a page was built from, so review
   * notes can tell the agent which file to change. Null when it doesn't know.
   */
  sourceFor?(pageUrl: string): string | null;
  /**
   * Optional: brings a page up to date before the browser reloads it, for
   * a site that serves a copy built from the vault, which an edit to the
   * vault file doesn't change. Terminus calls it on Reload, and when the
   * file sourceFor names for the page changes. Throw with a message the
   * user can act on; the page is reloaded either way.
   */
  refresh?(pageUrl: string): Promise<void>;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class BrowserSiteRegistry {
  private sites = new Map<string, BrowserSite>();
  private listeners = new Set<() => void>();

  /** Adds or replaces a site. Returns a function that removes it again
   *  (only if it hasn't been replaced since). */
  register(site: BrowserSite): () => void {
    if (typeof site !== "object" || site === null) throw new Error("registerSite needs a site");
    if (typeof site.id !== "string" || !ID_PATTERN.test(site.id)) {
      throw new Error(`A site id is lowercase letters, digits and dashes, not ${JSON.stringify(site.id)}`);
    }
    if (typeof site.name !== "string" || site.name.trim() === "") throw new Error("A site needs a name");
    if (typeof site.open !== "function") throw new Error("A site needs an open() function");
    const entry: BrowserSite = {
      id: site.id,
      name: site.name.trim().slice(0, 80),
      description: typeof site.description === "string" ? site.description.trim().slice(0, 300) : undefined,
      open: () => site.open(),
      sourceFor: typeof site.sourceFor === "function" ? (url) => site.sourceFor!(url) : undefined,
      refresh: typeof site.refresh === "function" ? (url) => Promise.resolve(site.refresh!(url)) : undefined,
    };
    this.sites.set(site.id, entry);
    this.changed();
    return () => {
      if (this.sites.get(site.id) !== entry) return;
      this.sites.delete(site.id);
      this.changed();
    };
  }

  get(id: string): BrowserSite | undefined {
    return this.sites.get(id);
  }

  list(): BrowserSite[] {
    return [...this.sites.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  clear(): void {
    this.sites.clear();
    this.changed();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
}

/**
 * An address with any query string and fragment taken off, for showing
 * where a registered site's page is without the token its first address
 * carried.
 */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
