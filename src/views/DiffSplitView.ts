import { ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { pathBasename } from "../node/fs";
import { renderSplitDiffBody } from "../diff/renderSplitDiff";
import type TerminusPlugin from "../main";

export const DIFF_SPLIT_VIEW_TYPE = "terminus-diff-split";

interface DiffSplitViewState {
  changeId?: string;
}

/** Dedicated split (old | new) diff view for one pending change, opened
 *  alongside the existing "Open" inline-editor overlay (not a replacement
 *  for it) -- see PendingChangesView's row actions. Keyed by the pending
 *  change's id (its file path), not a snapshot of the change itself, so it
 *  keeps rendering the latest state (including per-hunk resolutions) via
 *  the store's own "change" event, the same way PendingChangesView does. */
export class DiffSplitView extends ItemView {
  private changeId: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return DIFF_SPLIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.changeId ? `Diff: ${pathBasename(this.changeId)}` : "Split Diff";
  }

  getIcon(): string {
    return "diff";
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.changeId = (state as DiffSplitViewState | undefined)?.changeId ?? null;
    await super.setState(state, result);
    this.render();
  }

  getState(): Record<string, unknown> {
    return { changeId: this.changeId ?? undefined };
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("terminus-view", "terminus-diff-split-view");
    this.plugin.pendingChangesStore.on("change", this.render);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
  }

  private render = (): void => {
    const container = this.contentEl;
    container.empty();

    if (!this.changeId) {
      container.createDiv({ cls: "terminus-pending-empty", text: "No file selected." });
      return;
    }

    const change = this.plugin.pendingChangesStore.get(this.changeId);
    if (!change) {
      container.createDiv({
        cls: "terminus-pending-empty",
        text: "This change has already been fully resolved -- nothing left to review here.",
      });
      return;
    }

    const header = container.createDiv({ cls: "terminus-split-diff-header" });
    header.createEl("span", { cls: "terminus-split-diff-title", text: pathBasename(change.diff.filePath) });
    if (change.editCount > 1) {
      header.createEl("span", { cls: "terminus-pending-edit-count", text: `${change.editCount} edits` });
    }

    renderSplitDiffBody(container, this.plugin.pendingChangesStore, change);
  };
}

export async function openDiffSplitView(plugin: TerminusPlugin, changeId: string): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: DIFF_SPLIT_VIEW_TYPE, active: true, state: { changeId } });
  await plugin.app.workspace.revealLeaf(leaf);
}
