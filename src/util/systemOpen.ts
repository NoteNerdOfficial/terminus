import { Notice } from "obsidian";
import { pathBasename } from "terminus-node-bridge";

/**
 * Hands a real file to the OS, for the paths Obsidian structurally cannot
 * open in a leaf: dot-files and anything under a dot-folder (the vault index
 * excludes dot-prefixed paths outright, so getAbstractFileByPath never
 * returns one) and anything outside the vault.
 *
 * Electron's shell is reached the same way getOsFilePath() in TerminalView
 * already reaches webUtils -- a direct require rather than a bridge export,
 * since this is Electron's own surface and not one of the Node built-ins
 * terminus-node-bridge exists to contain.
 */
export function openWithSystemDefaultApp(absolutePath: string): void {
  try {
    const { shell } = require("electron") as {
      shell?: { openPath(path: string): Promise<string> };
    };
    if (!shell) {
      new Notice(`Terminus: can't open ${pathBasename(absolutePath)} outside Obsidian here.`);
      return;
    }
    // Resolves with an error *string* rather than rejecting, so a failure
    // (no handler registered for the type, permissions) is easy to miss.
    void shell.openPath(absolutePath).then((error) => {
      if (error) new Notice(`Terminus: couldn't open ${pathBasename(absolutePath)}: ${error}`);
    });
  } catch {
    new Notice(`Terminus: couldn't open ${pathBasename(absolutePath)} with the system default app.`);
  }
}
