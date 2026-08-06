import { MarkdownView, Notice, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { fileExistsSync, pathBasename, pathRelative } from "terminus-node-bridge";
import { setInlineDiff } from "./inlineDiff";
import { computeHunks } from "../diff/hunks";
import { PendingChange } from "../state/PendingChangesStore";
import { openWithSystemDefaultApp } from "../util/systemOpen";
import { errorMessage } from "../util/errors";
import type TerminusPlugin from "../main";

/**
 * What the panel's "Open" button does: opens the file, and nothing else.
 *
 * On a note it also decorates the editor with the change's inline diff, which
 * is the whole point of reviewing in place. On anything that can't carry those
 * decorations -- a .ts opened by a code-editor plugin, an image, a PDF -- the
 * file simply opens as it normally would. This used to detach that leaf and
 * substitute Split Diff, which meant "Open" answered a question the user
 * hadn't asked: Split Diff has its own button right next to this one, so
 * choosing it for them just took away the thing they clicked for.
 */
export async function openChangedFile(plugin: TerminusPlugin, change: PendingChange): Promise<void> {
  const { app } = plugin;
  const relPath = pathRelative(plugin.getVaultBasePath(), change.diff.filePath);
  // Obsidian's vault index structurally excludes dot-prefixed files/folders,
  // regardless of the "unhidden" plugin -- that plugin only patches
  // file-explorer/search/Bases display, it doesn't promote dotfiles into real
  // TFiles other plugins can openFile(). Those and out-of-vault paths go to
  // the OS, the same fallback a Cmd-clicked path in the terminal takes.
  const file = relPath.startsWith("..") ? null : app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof TFile)) {
    openOutsideObsidian(change.diff.filePath);
    return;
  }

  const leaf = app.workspace.getLeaf(true);
  // eState is how Obsidian itself scrolls a freshly-opened file to a line
  // (it's the same mechanism a search result or a [[Note#Heading]] link
  // uses). Scrolling has to be requested here rather than dispatched to
  // CodeMirror once openFile() resolves: the view applies its own
  // ephemeral state, scroll position included, as part of the open it is
  // still finishing when that promise settles, so a scroll issued
  // afterwards is simply overwritten and the file sits at the top.
  const firstHunkLine = findFirstHunkLine(change);
  await leaf.openFile(file, firstHunkLine === null ? undefined : { eState: { line: firstHunkLine } });

  // Everything past this point is the inline-diff overlay, which is a bonus
  // on top of the open rather than the reason for it -- so each of these
  // bails leaves the file open and just skips the decorations. The view is
  // something other than a MarkdownView whenever another plugin has claimed
  // the extension (a code editor for .ts, say) or Obsidian is showing its own
  // image/PDF/unsupported-file view; either way the file is on screen, which
  // is what was asked for.
  const view = leaf.view;
  if (!(view instanceof MarkdownView)) return;

  const cm = (view.editor as unknown as { cm?: EditorView }).cm;
  if (!cm) return;

  const store = plugin.pendingChangesStore;
  store.registerInlineOverlay(change.id, () => {
    cm.dispatch({ effects: setInlineDiff.of(null) });
  });

  const resolve = (accepted: boolean) => {
    store.resolveItem(change.id, accepted).catch((err: unknown) => {
      new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} ${pathBasename(change.diff.filePath)}: ${errorMessage(err)}`);
    });
  };

  cm.dispatch({
    effects: setInlineDiff.of({
      id: change.id,
      oldText: change.diff.oldText,
      newText: change.diff.newText,
      onAccept: () => resolve(true),
      onReject: () => resolve(false),
    }),
  });
}

/**
 * Line the first changed hunk starts on, for the caller to hand to
 * openFile() as ephemeral state. Null when the diff has no hunks at all.
 *
 * On anything longer than a screenful, opening at line 1 means hunting for
 * the change the panel just told you about: the decorations are there,
 * they are simply somewhere off-screen.
 */
function findFirstHunkLine(change: PendingChange): number | null {
  const firstHunk = computeHunks(change.diff.oldText, change.diff.newText)[0];
  if (!firstHunk) return null;

  // newStart is an offset into the post-edit text, which is what is on disk
  // and therefore what the document holds. Clamped anyway: the user may
  // have edited the note themselves between the hook capturing this change
  // and opening it here.
  const newText = change.diff.newText;
  const offset = Math.min(firstHunk.newStart, newText.length);
  let line = 0;
  for (let i = 0; i < offset; i++) {
    if (newText[i] === "\n") line++;
  }
  return line;
}

/**
 * For the files Obsidian can't put in a leaf at all. Handing them to the OS
 * is what "Open" plainly means, and it's already what a Cmd-clicked path in
 * the terminal does (see TerminalLinks.ts) -- the two entry points shouldn't
 * disagree about what opening a file is.
 */
function openOutsideObsidian(absolutePath: string): void {
  if (!fileExistsSync(absolutePath)) {
    // A file the change created and something has since deleted, or a path
    // that never resolved -- worth saying, since nothing will visibly happen.
    new Notice(`Terminus: couldn't find ${pathBasename(absolutePath)} on disk.`);
    return;
  }
  openWithSystemDefaultApp(absolutePath);
}
