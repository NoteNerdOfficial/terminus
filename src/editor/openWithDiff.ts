import { App, MarkdownView, Notice, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { pathBasename, pathRelative } from "terminus-node-bridge";
import { setInlineDiff } from "./inlineDiff";
import { PendingChange, PendingChangesStore } from "../state/PendingChangesStore";
import { errorMessage } from "../util/errors";

export async function openFileWithInlineDiff(
  app: App,
  vaultBasePath: string,
  store: PendingChangesStore,
  change: PendingChange
): Promise<void> {
  const relPath = pathRelative(vaultBasePath, change.diff.filePath);
  if (relPath.startsWith("..")) {
    new Notice("Terminus: file is outside the vault, can't open it as a note.");
    return;
  }

  const file = app.vault.getAbstractFileByPath(relPath);
  if (!(file instanceof TFile)) {
    // Obsidian's vault index structurally excludes dot-prefixed files/
    // folders, regardless of the "unhidden" plugin -- that plugin only
    // patches file-explorer/search/Bases display, it doesn't promote
    // dotfiles into real TFiles other plugins can openFile(). Split Diff
    // never needs a TFile (it renders the hook-captured text directly), so
    // it's the correct fallback here rather than a dead end.
    new Notice("Terminus: this file isn't visible to Obsidian's vault (e.g. a hidden dot-file/folder) -- use Split Diff to review it instead.");
    return;
  }

  const leaf = app.workspace.getLeaf(true);
  await leaf.openFile(file);
  const view = leaf.view;
  if (!(view instanceof MarkdownView)) {
    // The file is a real TFile but no plugin has registered its extension
    // as an editable view (registerExtensions()), so openFile() opened some
    // other view (or Obsidian's own unsupported-file placeholder) instead
    // of a MarkdownView -- previously this returned with no feedback at all.
    new Notice("Terminus: this file's type isn't registered as an editable view in Obsidian, so it can't show an inline diff -- use Split Diff to review it instead.");
    return;
  }

  const cm = (view.editor as unknown as { cm?: EditorView }).cm;
  if (!cm) {
    new Notice("Terminus: couldn't attach inline diff to this editor.");
    return;
  }

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
