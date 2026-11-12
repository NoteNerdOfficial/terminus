import {
  fileKind,
  pathExtname,
  pathJoin,
  pathRelative,
  randomHex,
  readFileBytesIfExists,
  realPathIfExists,
  type SimpleHttpRequest,
  type SimpleHttpResponse,
} from "terminus-node-bridge";
import { SERVE_PREFIX, contentTypeFor, isLoopbackHostHeader, isServableRelativePath, parseServeRequest } from "./policy";

export interface ServedSite {
  id: string;
  /** The folder, with symlinks resolved. */
  root: string;
  /** The terminal (hook token) it was served for. */
  ownerToken: string;
  /** `http://127.0.0.1:<port>/serve/<id>/`, ending in a slash. */
  baseUrl: string;
}

const INDEX_FILE = "index.html";

/**
 * Serves folders over the review server's http, at an address nobody can
 * guess (`/serve/<32 hex>/`), so the agent browser can open a prototype the
 * way a browser expects: relative links, ES modules and `fetch` all work,
 * which they don't from `file:`. The review server's other routes need a
 * terminal's token in a header; a <webview> can't send one, so the random
 * id is what stands in for it here.
 *
 * Only files inside the folder, symlinks resolved, and never a dotfile or
 * anything under a dot-folder. A site lasts until it's revoked: when the
 * browser view showing it closes, or when Obsidian quits.
 */
export class StaticSites {
  private sites = new Map<string, ServedSite>();

  constructor(private readonly port: () => number) {}

  /** Starts serving a folder. Throws if it isn't one. */
  async serve(folder: string, ownerToken: string): Promise<ServedSite> {
    const root = await realPathIfExists(folder);
    if (!root || (await fileKind(root)) !== "directory") throw new Error(`Not a folder: ${folder}`);
    const id = randomHex(16);
    const site: ServedSite = { id, root, ownerToken, baseUrl: `http://127.0.0.1:${this.port()}${SERVE_PREFIX}${id}/` };
    this.sites.set(id, site);
    return site;
  }

  get(id: string): ServedSite | undefined {
    return this.sites.get(id);
  }

  revoke(id: string): void {
    this.sites.delete(id);
  }

  clear(): void {
    this.sites.clear();
  }

  async handle(req: SimpleHttpRequest, res: SimpleHttpResponse): Promise<void> {
    if (!isLoopbackHostHeader(req.hostHeader, this.port())) return send(res, 403, "Wrong host");
    const request = parseServeRequest(req.url ?? "");
    if (request.kind === "redirect") {
      res.writeHead(301, { Location: request.location, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (request.kind === "invalid") return send(res, 404, "Not found");
    const site = this.sites.get(request.siteId);
    if (!site) return send(res, 404, "This page is no longer being served");

    let target = pathJoin(site.root, ...request.segments);
    let kind = await fileKind(target);
    if (kind === "directory") {
      if (!request.wantsDirectory) {
        // Relative links inside a folder's index.html need the slash.
        const path = (req.url ?? "").split(/[?#]/, 1)[0] ?? "";
        res.writeHead(301, { Location: `${path}/`, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      target = pathJoin(target, INDEX_FILE);
      kind = await fileKind(target);
    }
    if (kind !== "file") return send(res, 404, "Not found");

    // A symlink inside the folder can point outside it.
    const real = await realPathIfExists(target);
    if (!real || !isServableRelativePath(pathRelative(site.root, real))) return send(res, 404, "Not found");
    const bytes = await readFileBytesIfExists(real);
    if (!bytes) return send(res, 404, "Not found");

    res.writeHead(200, {
      "Content-Type": contentTypeFor(pathExtname(real)),
      "Content-Length": String(bytes.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }
}

function send(res: SimpleHttpResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
