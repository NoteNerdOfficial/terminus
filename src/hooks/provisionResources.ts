import { makeDirRecursive, makeExecutable, pathDirname, pathJoin, writeTextFile } from "terminus-node-bridge";
import { RESOURCE_FILES } from "../generated/resourceFiles";

/**
 * Obsidian's own installer (and every standard release download) only ever
 * fetches main.js/manifest.json/styles.css -- resources/ (pty_helper.py,
 * hook-bridge.sh, the shell-integration rc files) is never part of that,
 * even though PtyProcess/provisionSettings depend on those files existing
 * on disk. Their content is embedded into main.js at build time (see
 * esbuild.config.mjs's generateResourceFilesModule) and written out here,
 * every load, so they're actually present regardless of how the plugin was
 * installed -- unconditionally, not just if missing, so a version that
 * fixes a bug in one of these files takes effect on upgrade too.
 */
export async function provisionResources(pluginDir: string): Promise<void> {
  for (const file of RESOURCE_FILES) {
    const filePath = pathJoin(pluginDir, "resources", file.relativePath);
    await makeDirRecursive(pathDirname(filePath));
    await writeTextFile(filePath, file.content);
    if (file.executable) await makeExecutable(filePath);
  }
}
