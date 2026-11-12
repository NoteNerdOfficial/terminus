/**
 * Rules for the agent browser that don't need Obsidian or Node, so they can
 * be tested on their own: which addresses it may open, and how a request
 * for a served file maps onto the folder being served.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether the agent browser may load this address as a page or a frame:
 * http(s) on this machine only (localhost, 127.0.0.1, [::1], any port), or
 * about:blank. Everything else, `file:` included, is refused; local files
 * are served over http instead (see StaticSites).
 */
export function isAllowedBrowserUrl(raw: string): boolean {
  if (raw === "about:blank") return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Credentials in the address are a classic way to dress one host up as another.
  if (url.username || url.password) return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Whether a request's Host header names this server. A web page elsewhere
 * can point its own domain at 127.0.0.1 (DNS rebinding) and then read from
 * us as same-origin; its requests still carry its own domain here.
 */
export function isLoopbackHostHeader(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  return lower === `127.0.0.1:${port}` || lower === `localhost:${port}` || lower === `[::1]:${port}`;
}

export const SERVE_PREFIX = "/serve/";

export type ServeRequest =
  | { kind: "file"; siteId: string; segments: string[]; wantsDirectory: boolean }
  /** `/serve/<id>` with no slash after it: relative links only work from `/serve/<id>/`. */
  | { kind: "redirect"; location: string }
  | { kind: "invalid" };

/**
 * Splits a request path (`/serve/<id>/a/b.html?x=1`) into the site id and the
 * decoded path segments below it. Refuses anything that could step outside
 * the folder (`..`, encoded slashes, NUL) and any segment starting with a
 * dot, so `.git`, `.env` and `.obsidian` are never served.
 */
export function parseServeRequest(rawUrl: string): ServeRequest {
  const path = rawUrl.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith(SERVE_PREFIX)) return { kind: "invalid" };
  const rest = path.slice(SERVE_PREFIX.length);
  const slash = rest.indexOf("/");
  const siteId = slash === -1 ? rest : rest.slice(0, slash);
  if (!/^[0-9a-f]{32}$/.test(siteId)) return { kind: "invalid" };
  if (slash === -1) return { kind: "redirect", location: `${SERVE_PREFIX}${siteId}/` };

  const below = rest.slice(slash + 1);
  const wantsDirectory = below === "" || below.endsWith("/");
  const segments: string[] = [];
  for (const raw of below.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { kind: "invalid" };
    }
    if (segment.startsWith(".") || /[/\\\0]/.test(segment)) return { kind: "invalid" };
    segments.push(segment);
  }
  return { kind: "file", siteId, segments, wantsDirectory };
}

/**
 * Whether a path relative to a folder (as `path.relative(folder, target)`
 * gives it) stays inside that folder. "" is the folder itself.
 */
export function relativeStaysInside(relative: string): boolean {
  if (relative === "") return true;
  if (relative.startsWith("/") || relative.startsWith("\\") || /^[A-Za-z]:/.test(relative)) return false;
  const first = relative.split(/[/\\]/, 1)[0];
  return first !== "..";
}

/**
 * Whether a file, as a path relative to the served folder with symlinks
 * resolved, may be served: inside the folder and not under a dotfile or
 * dot-folder (a symlink named `notes` can still point at `.git`).
 */
export function isServableRelativePath(relative: string): boolean {
  if (relative === "" || !relativeStaysInside(relative)) return false;
  return !relative.split(/[/\\]/).some((segment) => segment.startsWith("."));
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/** The Content-Type for a file extension (with its dot, any case). */
export function contentTypeFor(extension: string): string {
  return CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}
