import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import * as path from "path";
import { PendingChange, ResolvedChange } from "../state/PendingChangesStore";
import { computeDiffStats, renderDiffBody } from "../diff/renderDiff";
import { openFileWithInlineDiff } from "../editor/openWithDiff";
import { openDiffSplitView } from "./DiffSplitView";
import { ActionLogModal } from "../modals/ActionLogModal";
import { ConfirmModal } from "../modals/ConfirmModal";
import { getGitHeadContent } from "../git/gitDiff";
import type TerminusPlugin from "../main";

export const PENDING_CHANGES_VIEW_TYPE = "terminus-pending-changes";

export class PendingChangesView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return PENDING_CHANGES_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Pending Changes";
  }

  getIcon(): string {
    return "diff";
  }

  async onOpen(): Promise<void> {
    this.plugin.pendingChangesStore.on("change", this.render);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
  }

  private render = (): void => {
    const container = this.contentEl;
    container.empty();
    container.addClass("terminus-pending-view");

    const changes = this.plugin.pendingChangesStore.list();
    const history = this.plugin.pendingChangesStore.listHistory();

    const header = container.createDiv({ cls: "terminus-pending-header" });

    if (changes.length === 0) {
      header.createEl("div", { text: "No pending changes", cls: "terminus-pending-empty" });
    } else {
      this.renderPendingSection(container, header, changes);
    }

    if (history.length > 0) {
      this.renderHistorySection(container, history);
    }
  };

  private renderPendingSection(container: HTMLElement, header: HTMLElement, changes: PendingChange[]): void {
    let totalAdded = 0;
    let totalRemoved = 0;
    const statsById = new Map<string, { added: number; removed: number }>();
    for (const change of changes) {
      const stats = computeDiffStats(change.diff);
      statsById.set(change.id, stats);
      totalAdded += stats.added;
      totalRemoved += stats.removed;
    }

    // Multiple terminals can each run their own claude session concurrently
    // -- group by originating terminal so it's clear which session made
    // which changes, while keeping this one unified panel (not one per
    // terminal).
    const groups = new Map<string, PendingChange[]>();
    for (const change of changes) {
      const group = groups.get(change.panelLabel) ?? [];
      group.push(change);
      groups.set(change.panelLabel, group);
    }

    const headerBar = header.createDiv({ cls: "terminus-pending-header-bar" });
    const headerText = headerBar.createDiv();
    const titleLine = headerText.createDiv({ cls: "terminus-pending-header-title-row" });
    titleLine.createEl("span", { cls: "terminus-pending-header-title", text: "Pending changes" });
    titleLine.createEl("span", { cls: "terminus-diff-stat-add", text: `+${totalAdded}` });
    titleLine.createEl("span", { cls: "terminus-diff-stat-remove", text: `-${totalRemoved}` });

    const subtitle = headerText.createEl("div", { cls: "terminus-pending-header-subtitle" });
    const filesLabel = `${changes.length} ${changes.length === 1 ? "file" : "files"}`;
    // "across N terminals" only earns its place once there's more than one
    // terminal to disambiguate -- for the common single-terminal case it's
    // just noise restating what's already obvious.
    subtitle.setText(groups.size > 1 ? `${filesLabel} across ${groups.size} terminals` : filesLabel);

    const bulkRow = headerBar.createDiv({ cls: "terminus-pending-bulk-actions" });
    bulkRow.createEl("button", { text: "Reject all", cls: "terminus-btn-outline" }).addEventListener(
      "click",
      () => void this.runBulkAction(false, changes.length, () => this.plugin.pendingChangesStore.resolveAll(false))
    );
    bulkRow.createEl("button", { text: "Keep all", cls: "terminus-btn-solid" }).addEventListener(
      "click",
      () => void this.runBulkAction(true, changes.length, () => this.plugin.pendingChangesStore.resolveAll(true))
    );

    const groupsContainer = container.createDiv({ cls: "terminus-pending-groups" });
    for (const [panelLabel, groupChanges] of groups) {
      this.renderTerminalGroup(groupsContainer, panelLabel, groupChanges, statsById);
    }
  }

  /** Shared by both the global and per-terminal Reject/Keep all buttons.
   *  `scopeLabel` (a terminal's display name) is omitted for the global
   *  buttons, which scopes the confirmation/error wording to "all" instead
   *  of naming a specific terminal. Confirmation itself is opt-in (see
   *  settings.confirmBulkActions) -- every bulk action is already
   *  reversible via "Recently resolved", so it's off by default. */
  private async runBulkAction(
    accepted: boolean,
    count: number,
    action: () => Promise<void>,
    scopeLabel?: string
  ): Promise<void> {
    if (this.plugin.settings.confirmBulkActions) {
      const verb = accepted ? "Keep" : "Reject";
      const scope = scopeLabel ? `${scopeLabel}'s` : "all";
      const confirmed = await ConfirmModal.confirm(
        this.app,
        `${verb} ${scope} pending changes?`,
        `This will ${accepted ? "keep" : "revert"} ${count} ${count === 1 ? "file" : "files"}${scopeLabel ? ` from ${scopeLabel}` : ""}.`,
        verb
      );
      if (!confirmed) return;
    }
    try {
      await action();
    } catch (err) {
      const target = scopeLabel ? `${scopeLabel}'s changes` : "all changes";
      new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} ${target}: ${(err as Error).message}`);
    }
  }

  private renderTerminalGroup(
    container: HTMLElement,
    panelLabel: string,
    changes: PendingChange[],
    statsById: Map<string, { added: number; removed: number }>
  ): void {
    let groupAdded = 0;
    let groupRemoved = 0;
    for (const change of changes) {
      const stats = statsById.get(change.id) ?? { added: 0, removed: 0 };
      groupAdded += stats.added;
      groupRemoved += stats.removed;
    }

    const group = container.createDiv({ cls: "terminus-group" });
    const groupHeader = group.createDiv({ cls: "terminus-group-header" });
    const chevron = groupHeader.createEl("span", { cls: "terminus-group-chevron", text: "▾" });

    // Two-line treatment matching the file rows below: heading (+ its
    // stats) on top, secondary count info stacked underneath, rather than
    // everything crammed into one row.
    const groupText = groupHeader.createDiv({ cls: "terminus-group-text" });
    const groupNameRow = groupText.createDiv({ cls: "terminus-group-name-row" });
    groupNameRow.createEl("span", { text: panelLabel, cls: "terminus-group-title" });
    groupNameRow.createEl("span", { cls: "terminus-group-stat-add", text: `+${groupAdded}` });
    groupNameRow.createEl("span", { cls: "terminus-group-stat-remove", text: `-${groupRemoved}` });
    groupText.createDiv({
      cls: "terminus-group-count",
      text: `${changes.length} ${changes.length === 1 ? "file" : "files"}`,
    });

    // Scoped to this terminal's own changes so reviewing one session's
    // batch doesn't touch another's, but demoted to borderless ghost
    // buttons -- the global Reject/Keep all above stays the obvious
    // default for "review everything", with per-terminal control still
    // one click away rather than competing for attention.
    const groupBulk = groupHeader.createDiv({ cls: "terminus-group-bulk-actions" });
    const inGroup = (change: PendingChange) => change.panelLabel === panelLabel;
    groupBulk.createEl("button", { text: "Reject all", cls: "terminus-btn-ghost" }).addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        void this.runBulkAction(false, changes.length, () => this.plugin.pendingChangesStore.resolveAll(false, inGroup), panelLabel);
      }
    );
    groupBulk.createEl("button", { text: "Keep all", cls: "terminus-btn-ghost-accent" }).addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        void this.runBulkAction(true, changes.length, () => this.plugin.pendingChangesStore.resolveAll(true, inGroup), panelLabel);
      }
    );

    const list = group.createDiv({ cls: "terminus-pending-list" });
    for (const change of changes) {
      this.renderRow(list, change, statsById.get(change.id) ?? { added: 0, removed: 0 });
    }

    // Terminal groups default open (matching a fresh review session where
    // you want everything visible); collapsing keeps a busy multi-session
    // run from overwhelming the panel once you've triaged a group.
    let groupExpanded = true;
    groupHeader.addEventListener("click", () => {
      groupExpanded = !groupExpanded;
      list.toggle(groupExpanded);
      chevron.setText(groupExpanded ? "▾" : "▸");
    });
  }

  private renderRow(list: HTMLElement, change: PendingChange, stats: { added: number; removed: number }): void {
    const row = list.createDiv({ cls: "terminus-pending-row" });
    const summary = row.createDiv({ cls: "terminus-pending-row-summary" });

    const chevron = summary.createEl("span", { cls: "terminus-pending-chevron", text: "▸" });

    const info = summary.createDiv({ cls: "terminus-pending-info" });
    const nameRow = info.createDiv({ cls: "terminus-pending-filename-row" });
    nameRow.createEl("span", { cls: "terminus-pending-filename", text: path.basename(change.diff.filePath) });
    nameRow.createEl("span", { cls: "terminus-diff-stat-add", text: `+${stats.added}` });
    nameRow.createEl("span", { cls: "terminus-diff-stat-remove", text: `-${stats.removed}` });
    if (change.editCount > 1) {
      nameRow.createEl("span", { cls: "terminus-pending-edit-count", text: `${change.editCount} edits` });
    }
    // Cut down from the system root, not the vault root: keeps the vault
    // folder name as a recognizable anchor ("Test1/notes/File 8.md")
    // instead of either the full "/Users/.../Test1/..." prefix or a bare
    // filename-relative-to-nowhere path.
    const vaultName = path.basename(this.plugin.getVaultBasePath());
    const relativePath = path.relative(this.plugin.getVaultBasePath(), change.diff.filePath);
    info.createEl("div", { cls: "terminus-pending-path", text: `${vaultName}/${relativePath}` });
    if (change.brokenBacklinks.length > 0) {
      const count = change.brokenBacklinks.length;
      info.createEl("div", {
        cls: "terminus-backlink-warning",
        text: `⚠ may break ${count} incoming ${count === 1 ? "link" : "links"}`,
      });
    }

    const stop = (e: MouseEvent, fn: () => void) => {
      e.stopPropagation();
      fn();
    };
    const resolve = (accepted: boolean) => {
      this.plugin.pendingChangesStore.resolveItem(change.id, accepted).catch((err: Error) => {
        new Notice(
          `Terminus: failed to ${accepted ? "keep" : "revert"} ${path.basename(change.diff.filePath)}: ${err.message}`
        );
      });
    };

    // Same Open/Reject/Accept treatment whether the row is collapsed or
    // expanded -- no swap to bigger full-text buttons on expand, so the
    // row doesn't visually jump as you review it.
    const actions = summary.createDiv({ cls: "terminus-pending-row-actions" });
    actions.createEl("button", { text: "Open", cls: "terminus-action-open" }).addEventListener("click", (e) =>
      stop(e, () => void openFileWithInlineDiff(this.app, this.plugin.getVaultBasePath(), this.plugin.pendingChangesStore, change))
    );
    // NotebookEdit's oldText/newText are a display-only approximation (not
    // the real file content, see server/diff.ts) -- per-hunk accept/reject
    // would splice that approximation and write it to disk, corrupting the
    // notebook, so the Split Diff entry point is hidden for those changes.
    if (change.payload.tool_name !== "NotebookEdit") {
      actions.createEl("button", { text: "Split Diff", cls: "terminus-action-open terminus-action-split-diff" }).addEventListener("click", (e) =>
        stop(e, () => void openDiffSplitView(this.plugin, change.id))
      );
    }
    actions
      .createEl("button", { text: "✕", cls: "terminus-icon-btn terminus-icon-btn-reject", attr: { "aria-label": "Reject" } })
      .addEventListener("click", (e) => stop(e, () => resolve(false)));
    actions
      .createEl("button", { text: "✓", cls: "terminus-icon-btn terminus-icon-btn-accept", attr: { "aria-label": "Accept" } })
      .addEventListener("click", (e) => stop(e, () => resolve(true)));

    const body = row.createDiv({ cls: "terminus-pending-row-body" });
    body.hide();
    this.renderRowBody(body, change);

    let expanded = false;
    summary.addEventListener("click", () => {
      expanded = !expanded;
      body.toggle(expanded);
      chevron.setText(expanded ? "▾" : "▸");
      row.toggleClass("is-expanded", expanded);
      summary.toggleClass("is-expanded", expanded);
    });
  }

  /** Three views over the same change, switched lazily (only rendered on
   *  first click, since Preview and Git are both more expensive than the
   *  plain-text diff): Diff (default, word-level text diff since last
   *  edit), Preview (renders the new content through Obsidian's own
   *  markdown pipeline -- how the note actually looks, not just its raw
   *  text), and "vs git HEAD" (an alternate, purely informational baseline
   *  for vaults under version control -- has no bearing on accept/reject,
   *  which always stays tied to the true pre-edit snapshot). */
  private renderRowBody(body: HTMLElement, change: PendingChange): void {
    if (change.brokenBacklinks.length > 0) {
      const warning = body.createDiv({ cls: "terminus-backlink-warning-detail" });
      warning.createEl("div", { text: "This edit removed a heading/block that other notes link to:" });
      const list = warning.createEl("ul");
      for (const link of change.brokenBacklinks) {
        list.createEl("li", {
          text: `${path.basename(link.sourceFile)} → #${link.isBlock ? "^" : ""}${link.fragment}`,
        });
      }
    }

    const toggleRow = body.createDiv({ cls: "terminus-body-view-toggle-row" });
    const toggle = toggleRow.createDiv({ cls: "terminus-body-view-toggle" });
    const diffBtn = toggle.createEl("button", { text: "Diff", cls: "is-active" });
    const previewBtn = toggle.createEl("button", { text: "Preview" });
    const gitBtn = toggle.createEl("button", { text: "vs git HEAD" });

    const diffContainer = body.createDiv();
    renderDiffBody(diffContainer, change.diff);

    const previewContainer = body.createDiv({ cls: "terminus-preview-body" });
    previewContainer.hide();

    const gitContainer = body.createDiv();
    gitContainer.hide();

    const buttons = [diffBtn, previewBtn, gitBtn];
    const containers = [diffContainer, previewContainer, gitContainer];
    const activate = (index: number) => {
      buttons.forEach((b, i) => b.toggleClass("is-active", i === index));
      containers.forEach((c, i) => c.toggle(i === index));
    };

    let previewRendered = false;
    let gitRendered = false;

    diffBtn.addEventListener("click", () => activate(0));

    previewBtn.addEventListener("click", () => {
      activate(1);
      if (previewRendered) return;
      previewRendered = true;
      const relPath = path.relative(this.plugin.getVaultBasePath(), change.diff.filePath);
      void MarkdownRenderer.render(this.app, change.diff.newText, previewContainer, relPath, this);
    });

    gitBtn.addEventListener("click", () => {
      activate(2);
      if (gitRendered) return;
      gitRendered = true;
      void this.renderGitDiff(gitContainer, change);
    });
  }

  private async renderGitDiff(container: HTMLElement, change: PendingChange): Promise<void> {
    const headContent = await getGitHeadContent(this.plugin.getVaultBasePath(), change.diff.filePath);
    container.empty();
    if (headContent === null) {
      container.createEl("div", {
        cls: "terminus-pending-empty",
        text: "Not tracked in git, or this vault isn't a git repository.",
      });
      return;
    }
    renderDiffBody(container, {
      filePath: change.diff.filePath,
      oldText: headContent,
      newText: change.diff.newText,
      existedBefore: true,
      revertText: headContent,
    });
  }

  private renderHistorySection(container: HTMLElement, history: ResolvedChange[]): void {
    const section = container.createDiv({ cls: "terminus-history-section" });
    const summary = section.createEl("div", { cls: "terminus-history-toggle" });
    const chevron = summary.createEl("span", { cls: "terminus-pending-chevron", text: "▸" });
    summary.createEl("span", { text: `Recently resolved (${history.length})` });

    const list = section.createDiv({ cls: "terminus-history-list" });
    list.hide();
    for (const item of history) {
      this.renderHistoryRow(list, item);
    }
    list.createEl("button", { text: "View full log…", cls: "terminus-view-full-log" }).addEventListener(
      "click",
      () => new ActionLogModal(this.app, this.plugin.actionLog).open()
    );

    let expanded = false;
    summary.addEventListener("click", () => {
      expanded = !expanded;
      list.toggle(expanded);
      chevron.setText(expanded ? "▾" : "▸");
    });
  }

  private renderHistoryRow(list: HTMLElement, item: ResolvedChange): void {
    const row = list.createDiv({ cls: "terminus-history-row" });
    row.createEl("span", {
      cls: item.accepted ? "terminus-diff-stat-add" : "terminus-diff-stat-remove",
      text: item.accepted ? "Kept" : "Reverted",
    });
    row.createEl("span", { cls: "terminus-history-filename", text: path.basename(item.diff.filePath) });
    row.createEl("button", { text: "Undo", cls: "terminus-btn-ghost-accent" }).addEventListener("click", () => {
      this.plugin.pendingChangesStore.undo(item.historyId).catch((err: Error) => {
        new Notice(`Terminus: failed to undo: ${err.message}`);
      });
    });
  }
}
