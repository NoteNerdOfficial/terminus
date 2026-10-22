import { ItemView, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { PendingChange } from "../state/PendingChangesStore";
import type { ShellChange } from "../state/AgentSessionStore";
import { computeDiffStats } from "../diff/renderDiff";
import {
  ChangeRowContext,
  SHELL_CHANGE_TOOLTIP,
  renderChangeRow,
  renderHistorySection,
  renderShellChangeRows,
  runBulkAction,
} from "./changeRows";
import type { ClassicUiState } from "../state/ClassicUiState";
import type TerminusPlugin from "../main";

export const PENDING_CHANGES_VIEW_TYPE = "terminus-pending-changes";

export class PendingChangesView extends ItemView {
  /** What the shell-change list looked like at the last render; see
   *  onSessionChange. */
  private shellSignature = "";

  /** How the user has arranged the panel. Kept on the plugin, not here:
   *  Obsidian rebuilds a deferred sidebar view, and this panel re-renders on
   *  every recorded edit, so view-held state sprang every fold back open. */
  private get ui(): ClassicUiState {
    return this.plugin.classicUi;
  }

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
    // Shell changes with no reviewable before-state live on the session,
    // not in the pending-change store, so they need their own signal.
    this.plugin.agentSessionStore.on("change", this.onSessionChange);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
    this.plugin.agentSessionStore.off("change", this.onSessionChange);
  }

  /** The session store emits on every status flip -- working, idle, needs
   *  attention -- many times a turn, and a re-render here would drop the
   *  panel's scroll position and pop collapsed terminal groups back open.
   *  Only an actual change to the shell-change list is worth redrawing for. */
  private onSessionChange = (): void => {
    const signature = this.shellChangeSignature();
    if (signature === this.shellSignature) return;
    this.shellSignature = signature;
    this.render();
  };

  private shellChanges(): ShellChange[] {
    return this.plugin.groups
      .terminals()
      .flatMap((view) => this.plugin.agentSessionStore.get(view.hookToken)?.shellChanges ?? []);
  }

  private shellChangeSignature(): string {
    return this.shellChanges()
      .map((change) => `${change.filePath}:${change.status}`)
      .join("\u0000");
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

    this.renderShellChanges(container);

    if (history.length > 0) {
      renderHistorySection(this.rows, container, history);
    }
  };

  /**
   * The files git reported as changed during a turn that no hook and no
   * Bash snapshot could give a before-state for. Everything recoverable is
   * already a row above; this is what's left, and leaving it out entirely
   * is what used to make an empty panel read as "nothing happened".
   *
   * Pooled across terminals, since Classic's panel is one unified list
   * rather than the inbox's card per session.
   */
  private renderShellChanges(container: HTMLElement): void {
    // With detection off nothing refreshes this list, so whatever it last
    // held would sit here indefinitely claiming to describe the session.
    if (!this.plugin.settings.detectShellChanges) return;
    const changes = this.shellChanges();
    this.shellSignature = this.shellChangeSignature();
    if (changes.length === 0) return;

    const section = container.createDiv({ cls: "terminus-inbox-shell" });
    const head = section.createDiv({ cls: "terminus-inbox-shell-head" });
    setIcon(head.createSpan({ cls: "terminus-inbox-chevron" }), this.ui.shellExpanded ? "chevron-down" : "chevron-right");
    setIcon(head.createSpan({ cls: "terminus-meta-icon" }), "terminal");
    const count = `${changes.length} ${changes.length === 1 ? "file" : "files"}`;
    head.createSpan({ text: `${count} changed without a snapshot` });
    setTooltip(head, SHELL_CHANGE_TOOLTIP);
    head.setAttr("aria-expanded", String(this.ui.shellExpanded));
    head.addEventListener("click", () => {
      this.ui.shellExpanded = !this.ui.shellExpanded;
      this.render();
    });
    if (!this.ui.shellExpanded) return;

    renderShellChangeRows(this.rows, section, changes);
  }

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
    // run from overwhelming the panel once you've triaged a group. The
    // collapsed set lives on the view, not in this closure: the panel
    // re-renders on every store change, and a local would have sprung every
    // group back open each time Claude recorded another edit.
    const collapsed = this.ui.collapsedGroups.has(panelLabel);
    list.toggle(!collapsed);
    chevron.setText(collapsed ? "▸" : "▾");
    groupHeader.addEventListener("click", () => {
      if (this.ui.collapsedGroups.has(panelLabel)) this.ui.collapsedGroups.delete(panelLabel);
      else this.ui.collapsedGroups.add(panelLabel);
      const nowCollapsed = this.ui.collapsedGroups.has(panelLabel);
      list.toggle(!nowCollapsed);
      chevron.setText(nowCollapsed ? "▸" : "▾");
    });
  }

}
