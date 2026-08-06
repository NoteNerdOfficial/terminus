import { Notice } from "obsidian";
import { shell } from "electron";
import { pathBasename } from "terminus-node-bridge";

/**
 * Hands a real file to the OS, for the paths Obsidian structurally cannot
 * open in a leaf: dot-files and anything under a dot-folder (the vault index
 * excludes dot-prefixed paths outright, so getAbstractFileByPath never
 * returns one) and anything outside the vault.
 *
 * Electron's shell is reached the same way getOsFilePath() in TerminalView
 * already reaches webUtils -- a hand-declared module (see
 * src/types/electron.d.ts), since this is Electron's own surface and not
 * one of the Node built-ins terminus-node-bridge exists to contain.
 */
export function openWithSystemDefaultApp(absolutePath: string): void {
  if (!shell) {
    new Notice(`Terminus: can't open ${pathBasename(absolutePath)} outside Obsidian here.`);
    return;
  }
  try {
    // Resolves with an error *string* rather than rejecting, so a failure
    // (no handler registered for the type, permissions) is easy to miss.
    void shell.openPath(absolutePath).then((error) => {
      if (error) new Notice(`Terminus: couldn't open ${pathBasename(absolutePath)}: ${error}`);
    });
  } catch {
    new Notice(`Terminus: couldn't open ${pathBasename(absolutePath)} with the system default app.`);
  }
}
