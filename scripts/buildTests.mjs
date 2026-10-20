#!/usr/bin/env node
/**
 * Bundles test/*.test.ts into test/.build/*.test.cjs for `node --test`.
 *
 * Two things make this necessary rather than running the tests directly:
 * Node 20 can't load TypeScript, and the plugin's own modules import
 * "obsidian", which only exists inside Obsidian. esbuild is already a dev
 * dependency and solves both -- the import is aliased to the small stub in
 * test/helpers, so no test framework and no new packages are needed.
 */
import { build } from "esbuild";
import { readdirSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const outdir = join(root, "test", ".build");
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const entryPoints = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(root, "test", name));

if (entryPoints.length === 0) {
  console.error("No test/*.test.ts files found.");
  process.exit(1);
}

await build({
  entryPoints,
  outdir,
  bundle: true,
  platform: "node",
  format: "cjs",
  // node --test discovers *.test.cjs; without this they'd land as .js.
  outExtension: { ".js": ".cjs" },
  sourcemap: "inline",
  logLevel: "warning",
  alias: { obsidian: join(root, "test", "helpers", "obsidian-stub.ts") },
  // Imported by a couple of modules these tests pull in transitively, and
  // never reached from a test; leaving it external keeps the bundle honest.
  external: ["electron"],
});

console.log(`Bundled ${entryPoints.length} test file(s) into test/.build/`);
