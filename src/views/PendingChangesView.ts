import { ItemView, WorkspaceLeaf } from "obsidian";
import { PendingChange } from "../state/PendingChangesStore";
import { computeDiffStats } from "../diff/renderDiff";
import { ChangeRowContext, renderChangeRow, renderHistorySection, runBulkAction } from "./changeRows";
import type TerminusPlugin from "../main";

export const PENDING_CHANGES_VIEW_TYPE = "terminus-pending-changes";

export class PendingChangesView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  private get rows(): ChangeRowContext {
    return { plugin: this.plugin, component: this };
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
    this.plugin.dedupeView(PENDING_CHANGES_VIEW_TYPE);
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
      header.createDiv({ text: "No pending changes", cls: "terminus-pending-empty" });
    } else {
      this.renderPendingSection(container, header, changes);
    }

    if (history.length > 0) {
      renderHistorySection(this.rows, container, history);
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
    titleLine.createSpan({ cls: "terminus-pending-header-title", text: "Pending changes" });
    titleLine.createSpan({ cls: "terminus-diff-stat-add", text: `+${totalAdded}` });
    titleLine.createSpan({ cls: "terminus-diff-stat-remove", text: `-${totalRemoved}` });

    const subtitle = headerText.createDiv({ cls: "terminus-pending-header-subtitle" });
    const filesLabel = `${changes.length} ${changes.length === 1 ? "file" : "files"}`;
    // "across N terminals" only earns its place once there's more than one
    // terminal to disambiguate -- for the common single-terminal case it's
    // just noise restating what's already obvious.
    subtitle.setText(groups.size > 1 ? `${filesLabel} across ${groups.size} terminals` : filesLabel);

    const bulkRow = headerBar.createDiv({ cls: "terminus-pending-bulk-actions" });
    bulkRow.createEl("button", { text: "Reject all", cls: "terminus-btn-outline" }).addEventListener(
      "click",
      () => void runBulkAction(this.rows, false, changes, () => this.plugin.pendingChangesStore.resolveAll(false))
    );
    bulkRow.createEl("button", { text: "Keep all", cls: "terminus-btn-solid" }).addEventListener(
      "click",
      () => void runBulkAction(this.rows, true, changes, () => this.plugin.pendingChangesStore.resolveAll(true))
    );

    const groupsContainer = container.createDiv({ cls: "terminus-pending-groups" });
    for (const [panelLabel, groupChanges] of groups) {
      this.renderTerminalGroup(groupsContainer, panelLabel, groupChanges, statsById);
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
    // Snapshot from whichever change in the group recorded it first -- same
    // "cosmetic, point-in-time" caveat as panelLabel itself: if the
    // terminal's color changes mid-session, already-pending entries keep
    // whatever color they were recorded with. Rendered as an edge strip
    // (matching the terminal tab's own color indicator) spanning the whole
    // group card, not just its header row.
    const panelColor = changes[0]?.panelColor;
    if (panelColor) {
      group.addClass("terminus-group-colored");
      group.style.setProperty("--terminus-group-color", panelColor);
    }
    const groupHeader = group.createDiv({ cls: "terminus-group-header" });
    const chevron = groupHeader.createSpan({ cls: "terminus-group-chevron", text: "▾" });

    // Two-line treatment matching the file rows below: heading (+ its
    // stats) on top, secondary count info stacked underneath, rather than
    // everything crammed into one row.
    const groupText = groupHeader.createDiv({ cls: "terminus-group-text" });
    const groupNameRow = groupText.createDiv({ cls: "terminus-group-name-row" });
    groupNameRow.createSpan({ text: panelLabel, cls: "terminus-group-title" });
    groupNameRow.createSpan({ cls: "terminus-group-stat-add", text: `+${groupAdded}` });
    groupNameRow.createSpan({ cls: "terminus-group-stat-remove", text: `-${groupRemoved}` });
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
        void runBulkAction(this.rows, false, changes, () => this.plugin.pendingChangesStore.resolveAll(false, inGroup), panelLabel);
      }
    );
    groupBulk.createEl("button", { text: "Keep all", cls: "terminus-btn-ghost-accent" }).addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        void runBulkAction(this.rows, true, changes, () => this.plugin.pendingChangesStore.resolveAll(true, inGroup), panelLabel);
      }
    );

    const list = group.createDiv({ cls: "terminus-pending-list" });
    for (const change of changes) {
      renderChangeRow(this.rows, list, change, statsById.get(change.id) ?? { added: 0, removed: 0 });
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

}
