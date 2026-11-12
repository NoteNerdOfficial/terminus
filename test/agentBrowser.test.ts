import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewServer } from "../src/server/ReviewServer";
import { StaticSites } from "../src/browser/StaticSites";
import {
  contentTypeFor,
  isAllowedBrowserUrl,
  isLoopbackHostHeader,
  isServableRelativePath,
  parseServeRequest,
  relativeStaysInside,
} from "../src/browser/policy";

const SITE = "0123456789abcdef0123456789abcdef";

describe("agent browser address policy", () => {
  it("opens pages on this computer", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:8080/index.html?x=1#top",
      "https://localhost/",
      "http://[::1]:3000/",
      "http://LOCALHOST:3000/",
      "http://127.1/",
      "about:blank",
    ]) {
      assert.equal(isAllowedBrowserUrl(url), true, url);
    }
  });

  it("refuses everything else", () => {
    for (const url of [
      "https://example.com/",
      "http://127.0.0.1.example.com/",
      "http://localhost.example.com/",
      "http://user:pw@localhost/",
      "http://0.0.0.0:3000/",
      "http://192.168.1.10/",
      "file:///Users/me/notes/index.html",
      "data:text/html,<p>hi</p>",
      "javascript:alert(1)",
      "chrome://settings",
      "not a url",
      "",
    ]) {
      assert.equal(isAllowedBrowserUrl(url), false, url);
    }
  });

  it("accepts only this server's own Host header", () => {
    assert.equal(isLoopbackHostHeader("127.0.0.1:4000", 4000), true);
    assert.equal(isLoopbackHostHeader("localhost:4000", 4000), true);
    assert.equal(isLoopbackHostHeader("[::1]:4000", 4000), true);
    assert.equal(isLoopbackHostHeader("127.0.0.1:4001", 4000), false);
    assert.equal(isLoopbackHostHeader("evil.example:4000", 4000), false);
    assert.equal(isLoopbackHostHeader(undefined, 4000), false);
  });
});

describe("served paths", () => {
  it("splits a request into the site and decoded segments", () => {
    assert.deepEqual(parseServeRequest(`/serve/${SITE}/proto/My%20Page.html?v=2`), {
      kind: "file",
      siteId: SITE,
      segments: ["proto", "My Page.html"],
      wantsDirectory: false,
    });
    assert.deepEqual(parseServeRequest(`/serve/${SITE}/`), { kind: "file", siteId: SITE, segments: [], wantsDirectory: true });
    assert.deepEqual(parseServeRequest(`/serve/${SITE}/pages/`), { kind: "file", siteId: SITE, segments: ["pages"], wantsDirectory: true });
  });

  it("redirects the bare site address to its folder", () => {
    assert.deepEqual(parseServeRequest(`/serve/${SITE}`), { kind: "redirect", location: `/serve/${SITE}/` });
  });

  it("refuses ways out of the folder and dotfiles", () => {
    for (const path of [
      `/serve/${SITE}/../secret.txt`,
      `/serve/${SITE}/a/%2e%2e/b`,
      `/serve/${SITE}/a%2Fb`,
      `/serve/${SITE}/a%5Cb`,
      `/serve/${SITE}/a%00b`,
      `/serve/${SITE}/.git/config`,
      `/serve/${SITE}/.env`,
      `/serve/${SITE}/%E0%A4%A`,
      `/serve/not-an-id/index.html`,
      `/review`,
    ]) {
      assert.deepEqual(parseServeRequest(path), { kind: "invalid" }, path);
    }
  });

  it("knows when a relative path stays inside", () => {
    assert.equal(relativeStaysInside(""), true);
    assert.equal(relativeStaysInside("a/b.html"), true);
    assert.equal(relativeStaysInside("..a/b"), true);
    assert.equal(relativeStaysInside("../b"), false);
    assert.equal(relativeStaysInside(".."), false);
    assert.equal(relativeStaysInside("/etc/passwd"), false);
    assert.equal(relativeStaysInside("C:\\x"), false);
    assert.equal(isServableRelativePath("a/b.html"), true);
    assert.equal(isServableRelativePath(""), false);
    assert.equal(isServableRelativePath(".git/config"), false);
    assert.equal(isServableRelativePath("a/.hidden/b"), false);
  });

  it("names content types", () => {
    assert.equal(contentTypeFor(".HTML"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor(".mjs"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeFor(".woff2"), "font/woff2");
    assert.equal(contentTypeFor(".xyz"), "application/octet-stream");
  });
});

describe("serving a folder", () => {
  const server = new ReviewServer();
  const sites = new StaticSites(() => server.getPort());
  let dir = "";
  let base = "";

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "terminus-sites-")));
    const proto = join(dir, "proto");
    mkdirSync(join(proto, "pages"), { recursive: true });
    mkdirSync(join(proto, ".git"));
    writeFileSync(join(proto, "index.html"), "<h1>Home</h1>");
    writeFileSync(join(proto, "pages", "index.html"), "<h1>Pages</h1>");
    writeFileSync(join(proto, "app.mjs"), "export {}");
    writeFileSync(join(proto, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    writeFileSync(join(proto, ".git", "config"), "secret");
    writeFileSync(join(dir, "outside.txt"), "outside");
    symlinkSync(join(dir, "outside.txt"), join(proto, "escape.txt"));
    symlinkSync(join(proto, ".git"), join(proto, "notgit"));
    symlinkSync(join(proto, "index.html"), join(proto, "alias.html"));
    await server.start();
    server.setStaticHandler((req, res) => sites.handle(req, res));
    const site = await sites.serve(proto, "owner");
    base = site.baseUrl;
  });

  after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function get(url: string): Promise<{ status: number; type: string | null; body: Buffer; location: string | null }> {
    const res = await fetch(url, { redirect: "manual" });
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      body: Buffer.from(await res.arrayBuffer()),
      location: res.headers.get("location"),
    };
  }

  it("serves the folder's files with their types", async () => {
    const home = await get(base);
    assert.equal(home.status, 200);
    assert.equal(home.type, "text/html; charset=utf-8");
    assert.equal(home.body.toString(), "<h1>Home</h1>");
    assert.equal((await get(`${base}app.mjs`)).type, "text/javascript; charset=utf-8");
    const logo = await get(`${base}logo.png`);
    assert.equal(logo.type, "image/png");
    assert.deepEqual([...logo.body], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  it("serves a symlink that stays inside", async () => {
    assert.equal((await get(`${base}alias.html`)).body.toString(), "<h1>Home</h1>");
  });

  it("redirects a folder without its slash, then serves its index", async () => {
    const bare = await get(base.replace(/\/$/, ""));
    assert.equal(bare.status, 301);
    const noSlash = await get(`${base}pages`);
    assert.equal(noSlash.status, 301);
    assert.ok(noSlash.location?.endsWith("/pages/"));
    assert.equal((await get(`${base}pages/`)).body.toString(), "<h1>Pages</h1>");
  });

  it("never serves outside the folder, dotfiles, or an unknown site", async () => {
    assert.equal((await get(`${base}escape.txt`)).status, 404);
    assert.equal((await get(`${base}notgit/config`)).status, 404);
    assert.equal((await get(`${base}.git/config`)).status, 404);
    assert.equal((await get(`${base}missing.html`)).status, 404);
    const unknown = base.replace(/[0-9a-f]{32}/, "f".repeat(32));
    assert.equal((await get(unknown)).status, 404);
  });

  it("refuses a request addressed to another host name", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base, { headers: { Host: `rebound.example:${server.getPort()}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("stops serving a revoked site", async () => {
    const extra = await sites.serve(join(dir, "proto"), "owner");
    assert.equal((await get(extra.baseUrl)).status, 200);
    sites.revoke(extra.id);
    assert.equal((await get(extra.baseUrl)).status, 404);
  });

  it("only takes GET and HEAD; other routes still need a token", async () => {
    const head = await fetch(base, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String("<h1>Home</h1>".length));
    const post = await fetch(base, { method: "POST", body: "x" });
    assert.equal(post.status, 404);
    const review = await fetch(`http://127.0.0.1:${server.getPort()}/review`, { method: "POST", body: "{}" });
    assert.equal(review.status, 403);
  });
});
