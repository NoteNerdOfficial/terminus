import { ItemView, Menu, setIcon, setTooltip, TFile, WorkspaceLeaf } from "obsidian";
import { pathBasename, pathRelative } from "terminus-node-bridge";
import { TerminalView } from "./TerminalView";
import { guardRenderDuringPress } from "./renderGuard";
import { iconButton, iconLabel, makeActivatable } from "./uiHelpers";
import type { TerminalGroup } from "../state/GroupStore";
import type { GroupTarget } from "../groups/GroupController";
import { refreshTabPendingDot } from "../terminal/tabHeaderColor";
import { COMMUNITY_PLUGIN_URL } from "../pluginVersion";
import { isNoteStatus, noteFile, noteStatus, openGroupNote, setNoteStatus } from "../groups/groupNotes";
import { addMoveItems, showGroupMenu } from "../groups/groupMenus";
import type TerminusPlugin from "../main";

export const TERMINUS_SIDEBAR_VIEW_TYPE = "terminus-sidebar";

/** Drag payload: the hook tokens of the terminals being moved. */
const DRAG_TYPE = "application/x-terminus-terminals";

/**
 * The Multi-agent experience's left sidebar: every terminal, under its group
 * or Ungrouped, with the groups' controls. Re-rendered on store and
 * workspace events; never polls, and never reads a terminal's view state.
 */
export class TerminusSidebarView extends ItemView {
  /** Terminals selected with ⌘/Ctrl/Shift-click, by hook token. */
  private selected = new Set<string>();
  /** The group whose name is being edited inline. */
  private renamingGroupId: string | null = null;
  /** The terminal token or group id whose × is asking "Close anyway?". */
  private confirmingClose: string | null = null;
  /** Emptying the view blurs a focused rename field, whose handler renders
   *  again; a render asked for mid-render waits until this one is done. */
  private rendering = false;
  private renderQueued = false;
  /** Set in onOpen: holds renders while a mouse button is down here. */
  private guardedRender: () => void = () => this.renderSafely();
  /** The terminal last used, highlighted in its row. Kept while the user
   *  works in the sidebar itself, which makes no terminal active. */
  private focusedToken: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return TERMINUS_SIDEBAR_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Terminus";
  }

  getIcon(): string {
    return this.plugin.settings.ribbonIcon;
  }

  async onOpen(): Promise<void> {
    this.plugin.dedupeView(TERMINUS_SIDEBAR_VIEW_TYPE);
    this.plugin.groupStore.on("change", this.render);
    this.plugin.agentSessionStore.on("change", this.render);
    this.plugin.pendingChangesStore.on("change", this.render);
    this.guardedRender = guardRenderDuringPress(this, this.contentEl, () => this.renderSafely());
    this.registerEvent(this.app.workspace.on("layout-change", this.render));
    // Only the highlight changes, in place: rebuilding here would swap out
    // the row under the pointer when a click is what made this pane
    // active, losing that click.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshFocus()));
    this.focusedToken = this.app.workspace.getActiveViewOfType(TerminalView)?.hookToken ?? null;
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.groupStore.off("change", this.render);
    this.plugin.agentSessionStore.off("change", this.render);
    this.plugin.pendingChangesStore.off("change", this.render);
  }

  /** Starts editing a group's name, e.g. right after it's created. */
  startRename(groupId: string): void {
    this.renamingGroupId = groupId;
    this.render();
  }

  /** Every re-render goes through here (see renderGuard.ts). */
  render = (): void => this.guardedRender();

  private refreshFocus(): void {
    const view = this.app.workspace.getActiveViewOfType(TerminalView);
    if (!view || view.hookToken === this.focusedToken) return;
    this.focusedToken = view.hookToken;
    this.contentEl.querySelectorAll<HTMLElement>(".terminus-sidebar-terminal").forEach((row) => {
      row.toggleClass("is-focused", row.dataset.token === this.focusedToken);
    });
  }

  private renderSafely(): void {
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    try {
      this.renderNow();
    } finally {
      this.rendering = false;
    }
    if (this.renderQueued) {
      this.renderQueued = false;
      window.setTimeout(this.render, 0);
    }
  }

  private renderNow(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("terminus-sidebar");

    const groups = this.plugin.groupStore.list();
    const terminals = this.plugin.groups.terminals();
    // Selection only holds terminals that still exist.
    const live = new Set(terminals.map((t) => t.hookToken));
    for (const token of this.selected) if (!live.has(token)) this.selected.delete(token);

    this.renderHeader(container, terminals);
    const list = container.createDiv({ cls: "terminus-sidebar-list" });
    if (groups.length === 0 && terminals.length === 0) {
      this.renderEmpty(list);
    } else {
      for (const group of groups) this.renderGroup(list, group, terminals.filter((t) => t.groupId === group.id));
      this.renderUngrouped(list, terminals.filter((t) => !t.groupId || !this.plugin.groupStore.get(t.groupId)));
    }

    refreshTabPendingDot(this.leaf, terminals.some((t) => this.status(t) === "needs-attention"));
  }

  /** Nothing open yet: say what the sidebar is for and how to start. */
  private renderEmpty(list: HTMLElement): void {
    const empty = list.createDiv({ cls: "terminus-sidebar-empty-state" });
    setIcon(empty.createDiv({ cls: "terminus-sidebar-empty-icon" }), "square-terminal");
    empty.createDiv({ cls: "terminus-sidebar-empty-title", text: "No terminals open" });
    empty.createDiv({
      cls: "terminus-sidebar-empty-text",
      text: "Open a terminal on its own, or start a group to keep the terminals for one piece of work together. Only the selected group's terminals show in the editor; the rest keep running.",
    });
  }

  private renderHeader(container: HTMLElement, terminals: TerminalView[]): void {
    const header = container.createDiv({ cls: "terminus-sidebar-header" });
    const brand = header.createDiv({ cls: "terminus-sidebar-brand" });
    brand.createSpan({ cls: "terminus-sidebar-title", text: "Terminus" });
    this.renderVersion(brand);

    const actions = header.createDiv({ cls: "terminus-sidebar-actions" });
    if (this.selected.size > 0) {
      actions.createSpan({ cls: "terminus-sidebar-selected", text: `${this.selected.size} selected` });
      actions.createEl("button", { text: "Group selected", cls: "mod-cta" }).addEventListener("click", () => {
        const views = terminals.filter((t) => this.selected.has(t.hookToken));
        this.selected.clear();
        void this.plugin.groups.createGroup(views).then((group) => this.startRename(group.id));
      });
      actions.createEl("button", { text: "Clear" }).addEventListener("click", () => {
        this.selected.clear();
        this.render();
      });
      return;
    }
    const plusButton = (label: string, tooltip: string) => {
      const button = actions.createEl("button", { cls: "terminus-sidebar-plus" });
      setIcon(button.createSpan(), "plus");
      button.createSpan({ text: label });
      setTooltip(button, tooltip);
      return button;
    };
    plusButton("Terminal", "New ungrouped terminal").addEventListener("click", () => void this.plugin.groups.newTerminal(null));
    plusButton("Group", "New group, with a new terminal in it").addEventListener("click", () => {
      void this.plugin.groups.createGroup().then((group) => this.startRename(group.id));
    });
  }

  /** "v1.0.36", or "v1.0.36 · Update" as an accent link when GitHub has a
   *  newer release (only with "Check for updates" on); opens Terminus in
   *  Community plugins either way. */
  private renderVersion(parent: HTMLElement): void {
    const status = this.plugin.pluginVersionStatus();
    const outdated = status.state === "outdated";
    const link = parent.createEl("a", {
      cls: `terminus-sidebar-version${outdated ? " is-outdated" : ""}`,
      text: outdated ? `v${status.installed} · Update` : `v${status.installed}`,
      href: "#",
    });
    link.addEventListener("click", (evt) => {
      evt.preventDefault();
      window.open(COMMUNITY_PLUGIN_URL);
    });
    setTooltip(
      link,
      outdated
        ? `Version ${status.latest} is available. Open Community plugins to update.`
        : status.state === "current"
          ? "You're on the latest version."
          : this.plugin.settings.multiAgent.checkForUpdates
            ? "Check Community plugins for updates."
            : "Update checks are off (Settings → Terminus). Open Community plugins to check."
    );
  }

  private renderGroup(list: HTMLElement, group: TerminalGroup, members: TerminalView[]): void {
    const active = this.plugin.groupStore.activeGroupId === group.id;
    const section = list.createDiv({ cls: "terminus-sidebar-group" });
    section.style.setProperty("--terminus-group-color", group.color);
    const row = section.createDiv({ cls: "terminus-sidebar-group-row" });
    row.toggleClass("is-active", active);
    this.makeDropTarget(row, group.id);
    makeActivatable(row, () => void this.plugin.groups.selectGroup(group.id), (evt) => this.showGroupMenu(evt, group));
    row.setAttr("aria-current", active ? "true" : "false");

    row.createSpan({ cls: "terminus-sidebar-swatch" });
    if (this.renamingGroupId === group.id) {
      this.renderRenameInput(row, group);
    } else {
      const name = row.createSpan({ cls: "terminus-sidebar-group-name", text: group.name });
      name.addEventListener("dblclick", (evt) => {
        evt.stopPropagation();
        this.startRename(group.id);
      });
    }
    const needsAttention = members.some((t) => this.status(t) === "needs-attention");
    if (needsAttention && !active) row.createSpan({ cls: "terminus-sidebar-attention", attr: { "aria-label": "A session here needs attention" } });
    row.createSpan({
      cls: "terminus-sidebar-group-state",
      text: members.length === 0 ? "No terminals" : active ? "Showing" : `${members.length} in background`,
    });

    const actions = row.createDiv({ cls: "terminus-sidebar-row-actions" });
    iconButton(actions, "plus", "New terminal in this group", () => void this.plugin.groups.newTerminal(group.id));
    this.renderCloseButton(actions, group.id, members, "Close this group and its terminals", () => this.plugin.groups.closeGroup(group.id), row);

    row.addEventListener("click", () => void this.plugin.groups.selectGroup(group.id));
    row.addEventListener("contextmenu", (evt) => this.showGroupMenu(evt, group));

    // Only what's particular to this group: its own folder (the vault root
    // is every group's default) and its linked note.
    const note = noteFile(this.plugin, group.note);
    const meta = group.folder || note ? section.createDiv({ cls: "terminus-sidebar-group-meta" }) : null;
    if (meta && group.folder) {
      const folder = iconLabel(meta, "folder", this.folderLabel(group.folder), "terminus-sidebar-folder");
      setTooltip(folder, "New terminals in this group start here");
    }
    if (meta && note) {
      const link = meta.createEl("a", { cls: "terminus-sidebar-note", href: "#" });
      setIcon(link.createSpan({ cls: "terminus-meta-icon" }), "file-text");
      link.createSpan({ text: note.basename });
      setTooltip(link, `Open ${note.path}`);
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        void openGroupNote(this.plugin, group.id);
      });
      const status = noteStatus(this.plugin, note);
      if (status) meta.createSpan({ cls: `terminus-sidebar-note-status is-${isNoteStatus(status) ? status : "other"}`, text: status });
      this.renderNoteSuggestion(section, group.id, note);
    }

    for (const view of members) this.renderTerminal(section, view);
  }

  /** "Turn finished. Move the note to review?" -- a suggestion only; the
   *  note changes only if the user says so. */
  private renderNoteSuggestion(section: HTMLElement, groupId: string, note: TFile): void {
    const suggestion = this.plugin.groups.noteSuggestions.get(groupId);
    if (!suggestion) return;
    // Stale once the note's status has moved on by other means.
    const current = noteStatus(this.plugin, note);
    if ((suggestion === "review" && current !== "active") || (suggestion === "active" && current !== "review")) {
      this.plugin.groups.noteSuggestions.delete(groupId);
      return;
    }
    const row = section.createDiv({ cls: "terminus-sidebar-suggestion" });
    row.createSpan({
      text: suggestion === "review" ? "Turn finished. Move the note to review?" : "Working again. Move the note back to active?",
    });
    row.createEl("button", { text: suggestion === "review" ? "Move to review" : "Move to active", cls: "mod-cta" }).addEventListener("click", () => {
      this.plugin.groups.noteSuggestions.delete(groupId);
      void setNoteStatus(this.plugin, note, suggestion);
    });
    row.createEl("button", { text: "Not now" }).addEventListener("click", () => {
      this.plugin.groups.noteSuggestions.delete(groupId);
      this.render();
    });
  }

  private renderRenameInput(row: HTMLElement, group: TerminalGroup): void {
    const input = row.createEl("input", { cls: "terminus-sidebar-rename", attr: { type: "text", value: group.name } });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.renamingGroupId = null;
      if (save) this.plugin.groupStore.rename(group.id, input.value);
      this.render();
    };
    input.addEventListener("click", (evt) => evt.stopPropagation());
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") finish(true);
      else if (evt.key === "Escape") finish(false);
    });
    // A re-render removes this field, which blurs it: that's not the user
    // leaving it, and the next render brings a fresh one back.
    input.addEventListener("blur", () => {
      if (!this.rendering && input.isConnected) finish(true);
    });
    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private renderUngrouped(list: HTMLElement, members: TerminalView[]): void {
    const section = list.createDiv({ cls: "terminus-sidebar-group is-ungrouped" });
    const row = section.createDiv({ cls: "terminus-sidebar-group-row is-ungrouped" });
    row.createSpan({ cls: "terminus-sidebar-group-name", text: "Ungrouped" });
    row.createSpan({ cls: "terminus-sidebar-group-state", text: "Shown in every group" });
    this.makeDropTarget(row, null);
    if (members.length === 0) {
      section.createDiv({ cls: "terminus-sidebar-empty", text: "Drag a terminal here to show it in every group." });
      return;
    }
    for (const view of members) this.renderTerminal(section, view);
  }

  private renderTerminal(section: HTMLElement, view: TerminalView): void {
    const token = view.hookToken;
    const row = section.createDiv({ cls: "terminus-sidebar-terminal" });
    row.toggleClass("is-selected", this.selected.has(token));
    row.dataset.token = token;
    row.toggleClass("is-focused", token === this.focusedToken);
    const color = view.effectiveColor;
    if (color) row.style.setProperty("--terminus-terminal-color", color);
    row.draggable = true;
    makeActivatable(row, () => void this.plugin.focusTerminal(token), (evt) => this.showMoveMenu(evt, this.dragSet(view)));

    row.createSpan({ cls: "terminus-sidebar-terminal-color" });
    row.createSpan({ cls: "terminus-sidebar-terminal-name", text: view.getDisplayText() });
    const pending = this.plugin.pendingChangesStore.list().filter((c) => c.contributors[0]?.token === token).length;
    if (pending > 0) {
      row.createSpan({ cls: "terminus-sidebar-pending", text: String(pending), attr: { "aria-label": `${pending} pending ${pending === 1 ? "change" : "changes"}` } });
    }
    const status = this.status(view);
    if (status) {
      row.createSpan({ cls: `terminus-sidebar-status is-${status}`, attr: { "aria-label": STATUS_LABELS[status] } });
    } else {
      row.createSpan({ cls: "terminus-sidebar-shell-tag", text: "Shell", attr: { title: "Claude isn't running here" } });
    }

    const actions = row.createDiv({ cls: "terminus-sidebar-row-actions" });
    iconButton(actions, "arrow-left-right", "Move to group", (evt) => this.showMoveMenu(evt, this.dragSet(view)));
    this.renderCloseButton(actions, token, [view], "Close terminal", () => this.plugin.groups.closeTerminals([view]), null);

    row.addEventListener("click", (evt) => {
      if (evt.metaKey || evt.ctrlKey || evt.shiftKey) {
        if (this.selected.has(token)) this.selected.delete(token);
        else this.selected.add(token);
        this.render();
        return;
      }
      void this.plugin.focusTerminal(token);
    });
    row.addEventListener("dragstart", (evt) => {
      const tokens = this.dragSet(view).map((t) => t.hookToken);
      evt.dataTransfer?.setData(DRAG_TYPE, JSON.stringify(tokens));
      if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
    });

    if (this.confirmingClose === token) this.renderCloseConfirm(section, token, () => this.plugin.groups.closeTerminals([view]));
  }

  /** × closes at once, unless a session in it is mid-turn or waiting on an
   *  answer: then it asks inline first. Pending changes never block it. */
  /** `groupRow`: a group's confirmation goes right under its row, before
   *  its terminals; a terminal's (null) is added after the row by
   *  renderTerminal. */
  private renderCloseButton(
    actions: HTMLElement,
    key: string,
    terminals: TerminalView[],
    label: string,
    close: () => void,
    groupRow: HTMLElement | null
  ): void {
    iconButton(actions, "x", label, () => {
      if (this.plugin.groups.busy(terminals).length > 0) {
        this.confirmingClose = key;
        this.render();
        return;
      }
      close();
    });
    if (groupRow && this.confirmingClose === key) this.renderCloseConfirm(groupRow.parentElement ?? groupRow, key, close, groupRow);
  }

  private renderCloseConfirm(parent: HTMLElement, key: string, close: () => void, after?: HTMLElement): void {
    if (parent.querySelector(`[data-confirm="${CSS.escape(key)}"]`)) return;
    const confirm = createDiv({ cls: "terminus-sidebar-confirm", attr: { "data-confirm": key } });
    if (after) after.after(confirm);
    else parent.appendChild(confirm);
    setIcon(confirm.createSpan({ cls: "terminus-meta-icon" }), "alert-triangle");
    confirm.createSpan({ cls: "terminus-sidebar-confirm-text", text: "Claude is mid-turn here. Close anyway?" });
    confirm.createEl("button", { text: "Close", cls: "mod-warning" }).addEventListener("click", () => {
      this.confirmingClose = null;
      close();
    });
    confirm.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.confirmingClose = null;
      this.render();
    });
  }

  /** The terminals a drag or ⇄ acts on: the whole selection when the row is
   *  part of it, otherwise just the row. */
  private dragSet(view: TerminalView): TerminalView[] {
    if (!this.selected.has(view.hookToken)) return [view];
    return this.plugin.groups.terminals().filter((t) => this.selected.has(t.hookToken));
  }

  private makeDropTarget(row: HTMLElement, target: GroupTarget): void {
    row.addEventListener("dragover", (evt) => {
      if (!evt.dataTransfer?.types.includes(DRAG_TYPE)) return;
      evt.preventDefault();
      row.addClass("is-drop-target");
    });
    row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
    row.addEventListener("drop", (evt) => {
      row.removeClass("is-drop-target");
      const raw = evt.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      evt.preventDefault();
      const tokens = new Set(JSON.parse(raw) as string[]);
      const views = this.plugin.groups.terminals().filter((t) => tokens.has(t.hookToken));
      this.selected.clear();
      this.plugin.groups.moveTerminals(views, target);
    });
  }

  private showMoveMenu(evt: MouseEvent, views: TerminalView[]): void {
    const menu = new Menu();
    addMoveItems(menu, this.plugin, { terminals: views }, () => this.selected.clear());
    menu.showAtMouseEvent(evt);
  }

  private showGroupMenu(evt: MouseEvent, group: TerminalGroup): void {
    evt.preventDefault();
    showGroupMenu(evt, this.plugin, group, {
      rename: () => this.startRename(group.id),
      close: () => {
        const members = this.plugin.groups.terminalsIn(group.id);
        if (this.plugin.groups.busy(members).length > 0) {
          this.confirmingClose = group.id;
          this.render();
        } else {
          this.plugin.groups.closeGroup(group.id);
        }
      },
    });
  }

  private status(view: TerminalView): SidebarStatus | null {
    const session = this.plugin.agentSessionStore.get(view.hookToken);
    if (!session?.running) return null;
    return session.status;
  }

  private folderLabel(folder: string | null): string {
    if (!folder) return pathBasename(this.plugin.getVaultBasePath());
    const relative = pathRelative(this.plugin.getVaultBasePath(), folder);
    return relative.startsWith("..") ? folder : relative || pathBasename(folder);
  }
}

type SidebarStatus = "working" | "needs-attention" | "finished-unread" | "idle";

const STATUS_LABELS: Record<SidebarStatus, string> = {
  working: "Working",
  "needs-attention": "Needs attention",
  "finished-unread": "Finished",
  idle: "Idle",
};
