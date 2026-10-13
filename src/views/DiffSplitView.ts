import { ItemView, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { pathBasename } from "terminus-node-bridge";
import { HunkCommentContext, renderSplitDiffBody } from "../diff/renderSplitDiff";
import { collisionLabel } from "../modals/collisions";
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
  /** Open comment boxes and their text, kept across re-renders. */
  private commentDrafts = new Map<string, string>();
  private openComments = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return DIFF_SPLIT_VIEW_TYPE;
  }

  /** The terminal (hook token) that made the change shown here: Split Diff
   *  belongs to that terminal's group (see TabVisibility). */
  shownChangeOwner(): string | null {
    if (!this.changeId) return null;
    return this.plugin.pendingChangesStore.get(this.changeId)?.contributors[0]?.token ?? null;
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
    // Showing another group's change switches to that group, so the tab
    // that was just asked for doesn't vanish.
    this.plugin.revealGroupOf(this.leaf);
  }

  getState(): Record<string, unknown> {
    return { changeId: this.changeId ?? undefined };
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("terminus-view", "terminus-diff-split-view");
    this.plugin.pendingChangesStore.on("change", this.render);
    this.plugin.feedbackStore.on("change", this.render);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
    this.plugin.feedbackStore.off("change", this.render);
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
    header.createSpan({ cls: "terminus-split-diff-title", text: pathBasename(change.diff.filePath) });
    if (change.editCount > 1) {
      header.createSpan({ cls: "terminus-pending-edit-count", text: `${change.editCount} edits` });
    }
    const collision = collisionLabel(change);
    if (collision) {
      const first = change.contributors[0]?.label ?? change.panelLabel;
      container.createDiv({
        cls: "terminus-collision-warning-detail",
        text: `⚠ ${collision} after ${first}. Rejecting goes back to how the file was before ${first}'s first edit, so it can undo their work too.`,
      });
    }

    // Comments go to the session that made the change (Multi-agent only).
    const owner = change.contributors[0]?.token;
    let comments: HunkCommentContext | undefined;
    if (this.plugin.experience === "multi-agent" && owner) {
      const recipient = this.plugin.findTerminalView(owner)?.getDisplayText() ?? change.panelLabel;
      comments = {
        feedback: this.plugin.feedbackStore,
        token: owner,
        terminalLabel: recipient,
        drafts: this.commentDrafts,
        open: this.openComments,
      };
      const queued = this.plugin.feedbackStore.listForFile(change.diff.filePath).length;
      if (queued > 0) {
        header.createSpan({
          cls: "terminus-split-diff-queued",
          text: `💬 ${queued} ${queued === 1 ? "comment" : "comments"} queued for ${recipient}`,
          attr: { title: "Send them from this session's card in the Agent inbox" },
        });
      }
    }

    renderSplitDiffBody(container, this.app, this.plugin.pendingChangesStore, change, comments);
  };
}

export async function openDiffSplitView(plugin: TerminusPlugin, changeId: string): Promise<void> {
  const leaf = plugin.app.workspace.getLeaf(true);
  await leaf.setViewState({ type: DIFF_SPLIT_VIEW_TYPE, active: true, state: { changeId } });
  await plugin.app.workspace.revealLeaf(leaf);
}
