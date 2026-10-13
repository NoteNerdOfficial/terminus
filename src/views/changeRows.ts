import { Component, MarkdownRenderer, Notice, setIcon, setTooltip } from "obsidian";
import { pathBasename, pathRelative } from "terminus-node-bridge";
import { PendingChange, ResolvedChange } from "../state/PendingChangesStore";
import { renderDiffBody } from "../diff/renderDiff";
import { openChangedFile } from "../editor/openWithDiff";
import { openDiffSplitView } from "./DiffSplitView";
import { ActionLogModal } from "../modals/ActionLogModal";
import { ConfirmModal } from "../modals/ConfirmModal";
import { collisionLabel, confirmCollisionReject, hasCollision } from "../modals/collisions";
import { getGitHeadContent } from "../git/gitDiff";
import { errorMessage } from "../util/errors";
import type TerminusPlugin from "../main";

/**
 * Pending-change rows, the "Recently resolved" list and the bulk-action
 * confirmation, shared by the Classic Pending Changes view and the
 * Multi-agent Agent inbox so a change reviews the same way in both.
 */

export interface ChangeRowContext {
  plugin: TerminusPlugin;
  /** Owns the Markdown preview's render lifecycle: the hosting view. */
  component: Component;
  /** "inbox" draws the Agent inbox's redesigned row (Multi-agent): counts
   *  on the right, Lucide icons, quiet Reject/Keep icons. Classic's
   *  Pending Changes keeps the original row until that design is settled. */
  variant?: "classic" | "inbox";
}

/** Shared by both the global and per-terminal Reject/Keep all buttons.
 *  `scopeLabel` (a terminal's display name) is omitted for the global
 *  buttons, which scopes the confirmation/error wording to "all" instead
 *  of naming a specific terminal. Confirmation itself is opt-in (see
 *  settings.confirmBulkActions) -- every bulk action is already
 *  reversible via "Recently resolved", so it's off by default. A reject
 *  that would undo another terminal's edits always asks, and that one
 *  confirmation replaces the generic one. */
export async function runBulkAction(
  ctx: ChangeRowContext,
  accepted: boolean,
  changes: PendingChange[],
  action: () => Promise<void>,
  scopeLabel?: string
): Promise<void> {
  const count = changes.length;
  if (!accepted && changes.some(hasCollision)) {
    if (!(await confirmCollisionReject(ctx.plugin.app, changes))) return;
  } else if (ctx.plugin.settings.confirmBulkActions) {
    const verb = accepted ? "Keep" : "Reject";
    const scope = scopeLabel ? `${scopeLabel}'s` : "all";
    const confirmed = await ConfirmModal.confirm(
      ctx.plugin.app,
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
    new Notice(`Terminus: failed to ${accepted ? "keep" : "revert"} ${target}: ${errorMessage(err)}`);
  }
}

/** `alsoEditedBy`: the other agents in the same session that edited the
 *  file, named; the inbox lists a change under the agent that edited it
 *  first, and this says who else did. `hideFolder`: the row sits under a
 *  folder heading that already says where it is. */
export function renderChangeRow(
  ctx: ChangeRowContext,
  list: HTMLElement,
  change: PendingChange,
  stats: { added: number; removed: number },
  opts: { alsoEditedBy?: string[]; hideFolder?: boolean } = {}
): void {
  const row = list.createDiv({ cls: "terminus-pending-row" });
  const summary = row.createDiv({ cls: "terminus-pending-row-summary" });

  const inbox = ctx.variant === "inbox";
  row.toggleClass("is-inbox", inbox);
  const chevron = summary.createSpan({ cls: "terminus-pending-chevron", text: "▸" });

  const info = summary.createDiv({ cls: "terminus-pending-info" });
  const nameRow = info.createDiv({ cls: "terminus-pending-filename-row" });
  nameRow.createSpan({ cls: "terminus-pending-filename", text: pathBasename(change.diff.filePath) });
  if (change.editCount > 1) {
    nameRow.createSpan({ cls: "terminus-pending-edit-count", text: `${change.editCount} edits` });
  }
  // Classic puts the counts beside the name; the inbox row sets them apart
  // on the right of the name line.
  const statsEl = inbox ? nameRow.createSpan({ cls: "terminus-pending-stats" }) : nameRow;
  statsEl.createSpan({ cls: "terminus-diff-stat-add", text: `+${stats.added}` });
  statsEl.createSpan({ cls: "terminus-diff-stat-remove", text: `-${stats.removed}` });
  // Cut down from the system root, not the vault root: keeps the vault
  // folder name as a recognizable anchor ("Test1/notes/File 8.md")
  // instead of either the full "/Users/.../Test1/..." prefix or a bare
  // filename-relative-to-nowhere path.
  const vaultName = pathBasename(ctx.plugin.getVaultBasePath());
  const relativePath = pathRelative(ctx.plugin.getVaultBasePath(), change.diff.filePath);
  if (!inbox) {
    info.createDiv({ cls: "terminus-pending-path", text: `${vaultName}/${relativePath}` });
  } else {
    // The inbox shows only where the file is, when that adds something: its
    // folder for a file in one, nothing for one at the vault's root (the
    // name above says it all), the full path for one outside the vault.
    const outside = relativePath.startsWith("..");
    const folder = outside ? change.diff.filePath : relativePath.split("/").slice(0, -1).join("/");
    if (folder && !opts.hideFolder) info.createDiv({ cls: "terminus-pending-path", text: outside ? folder : `${folder}/`, attr: { title: change.diff.filePath } });
  }
  const warning = (cls: string, text: string) => {
    if (!inbox) {
      info.createDiv({ cls, text: `⚠ ${text}` });
      return;
    }
    const el = info.createDiv({ cls: `${cls} terminus-pending-warning` });
    setIcon(el.createSpan({ cls: "terminus-meta-icon" }), "alert-triangle");
    el.createSpan({ text });
  };
  if (inbox && opts.alsoEditedBy && opts.alsoEditedBy.length > 0) {
    const el = info.createDiv({ cls: "terminus-pending-coeditors" });
    setIcon(el.createSpan({ cls: "terminus-meta-icon" }), "users");
    el.createSpan({ text: `Also edited by ${opts.alsoEditedBy.join(", ")}` });
  }
  const collision = collisionLabel(change);
  if (collision) warning("terminus-collision-warning", collision);
  if (change.brokenBacklinks.length > 0) {
    const count = change.brokenBacklinks.length;
    warning("terminus-backlink-warning", `may break ${count} incoming ${count === 1 ? "link" : "links"}`);
  }

  const stop = (e: MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };
  const resolve = async (accepted: boolean) => {
    if (!accepted && !(await confirmCollisionReject(ctx.plugin.app, [change]))) return;
    ctx.plugin.pendingChangesStore.resolveItem(change.id, accepted).catch((err: unknown) => {
      new Notice(
        `Terminus: failed to ${accepted ? "keep" : "revert"} ${pathBasename(change.diff.filePath)}: ${errorMessage(err)}`
      );
    });
  };

  // Same Open/Reject/Accept treatment whether the row is collapsed or
  // expanded -- no swap to bigger full-text buttons on expand, so the
  // row doesn't visually jump as you review it.
  const actions = summary.createDiv({ cls: "terminus-pending-row-actions" });
  if (inbox) {
    renderInboxRowActions(actions, ctx, change, stop, resolve);
  } else {
    actions.createEl("button", { text: "Open", cls: "terminus-action-open" }).addEventListener("click", (e) =>
      stop(e, () => void openChangedFile(ctx.plugin, change))
    );
    // NotebookEdit's oldText/newText are a display-only approximation (not
    // the real file content, see server/diff.ts) -- per-hunk accept/reject
    // would splice that approximation and write it to disk, corrupting the
    // notebook, so the Split Diff entry point is hidden for those changes.
    if (change.payload.tool_name !== "NotebookEdit") {
      actions.createEl("button", { text: "Split Diff", cls: "terminus-action-open terminus-action-split-diff" }).addEventListener("click", (e) =>
        stop(e, () => void openDiffSplitView(ctx.plugin, change.id))
      );
    }
    actions
      .createEl("button", { text: "✕", cls: "terminus-icon-btn terminus-icon-btn-reject", attr: { "aria-label": "Reject" } })
      .addEventListener("click", (e) => stop(e, () => void resolve(false)));
    actions
      .createEl("button", { text: "✓", cls: "terminus-icon-btn terminus-icon-btn-accept", attr: { "aria-label": "Accept" } })
      .addEventListener("click", (e) => stop(e, () => void resolve(true)));
  }

  const body = row.createDiv({ cls: "terminus-pending-row-body" });
  body.hide();
  renderRowBody(ctx, body, change);

  let expanded = false;
  const toggle = () => {
    expanded = !expanded;
    body.toggle(expanded);
    chevron.setText(expanded ? "▾" : "▸");
    row.toggleClass("is-expanded", expanded);
    summary.toggleClass("is-expanded", expanded);
    if (inbox) summary.setAttr("aria-expanded", String(expanded));
  };
  summary.addEventListener("click", toggle);
  if (inbox) {
    summary.setAttr("role", "button");
    summary.setAttr("tabindex", "0");
    summary.setAttr("aria-expanded", "false");
    summary.addEventListener("keydown", (evt) => {
      if (evt.target !== summary || (evt.key !== "Enter" && evt.key !== " ")) return;
      evt.preventDefault();
      toggle();
    });
  }
}

/**
 * The inbox row's actions, always shown: Split diff and Open as small
 * icon-and-label buttons, then Reject and Keep as plain icons that take
 * their colour (red, green) only on hover, each named in a tooltip.
 */
function renderInboxRowActions(
  actions: HTMLElement,
  ctx: ChangeRowContext,
  change: PendingChange,
  stop: (e: MouseEvent, fn: () => void) => void,
  resolve: (accepted: boolean) => Promise<void>
): void {
  const labelled = (icon: string, label: string, tooltip: string, run: () => void) => {
    const button = actions.createEl("button", { cls: "terminus-row-action" });
    setIcon(button.createSpan({ cls: "terminus-meta-icon" }), icon);
    button.createSpan({ text: label });
    setTooltip(button, tooltip);
    button.addEventListener("click", (e) => stop(e, run));
  };
  const iconOnly = (icon: string, cls: string, label: string, run: () => void) => {
    const button = actions.createEl("button", { cls: `clickable-icon terminus-row-resolve ${cls}`, attr: { "aria-label": label } });
    setIcon(button, icon);
    button.addEventListener("click", (e) => stop(e, run));
  };
  // See the Classic branch above for why NotebookEdit has no Split Diff.
  if (change.payload.tool_name !== "NotebookEdit") {
    labelled("columns-2", "Split diff", "Review it side by side, change by change", () => void openDiffSplitView(ctx.plugin, change.id));
  }
  labelled("arrow-up-right", "Open", "Open the file with the change shown inline", () => void openChangedFile(ctx.plugin, change));
  iconOnly("x", "is-reject", "Reject: revert this file", () => void resolve(false));
  iconOnly("check", "is-keep", "Keep this change", () => void resolve(true));
}

/** Three views over the same change, switched lazily (only rendered on
 *  first click, since Preview and Git are both more expensive than the
 *  plain-text diff): Diff (default, word-level text diff since last
 *  edit), Preview (renders the new content through Obsidian's own
 *  markdown pipeline -- how the note actually looks, not just its raw
 *  text), and "vs git HEAD" (an alternate, purely informational baseline
 *  for vaults under version control -- has no bearing on accept/reject,
 *  which always stays tied to the true pre-edit snapshot). */
function renderRowBody(ctx: ChangeRowContext, body: HTMLElement, change: PendingChange): void {
  if (change.brokenBacklinks.length > 0) {
    const warning = body.createDiv({ cls: "terminus-backlink-warning-detail" });
    warning.createDiv({ text: "This edit removed a heading/block that other notes link to:" });
    const list = warning.createEl("ul");
    for (const link of change.brokenBacklinks) {
      list.createEl("li", {
        text: `${pathBasename(link.sourceFile)} → #${link.isBlock ? "^" : ""}${link.fragment}`,
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
    const relPath = pathRelative(ctx.plugin.getVaultBasePath(), change.diff.filePath);
    void MarkdownRenderer.render(ctx.plugin.app, change.diff.newText, previewContainer, relPath, ctx.component);
  });

  gitBtn.addEventListener("click", () => {
    activate(2);
    if (gitRendered) return;
    gitRendered = true;
    void renderGitDiff(ctx, gitContainer, change);
  });
}

async function renderGitDiff(ctx: ChangeRowContext, container: HTMLElement, change: PendingChange): Promise<void> {
  const headContent = await getGitHeadContent(ctx.plugin.getVaultBasePath(), change.diff.filePath);
  container.empty();
  if (headContent === null) {
    container.createDiv({
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

export function renderHistorySection(ctx: ChangeRowContext, container: HTMLElement, history: ResolvedChange[]): void {
  const section = container.createDiv({ cls: "terminus-history-section" });
  const summary = section.createDiv({ cls: "terminus-history-toggle" });
  const chevron = summary.createSpan({ cls: "terminus-pending-chevron", text: "▸" });
  summary.createSpan({ text: `Recently resolved (${history.length})` });

  const list = section.createDiv({ cls: "terminus-history-list" });
  list.hide();
  for (const item of history) {
    renderHistoryRow(ctx, list, item);
  }
  list.createEl("button", { text: "View full log…", cls: "terminus-view-full-log" }).addEventListener(
    "click",
    () => new ActionLogModal(ctx.plugin.app, ctx.plugin.actionLog).open()
  );

  let expanded = false;
  summary.addEventListener("click", () => {
    expanded = !expanded;
    list.toggle(expanded);
    chevron.setText(expanded ? "▾" : "▸");
  });
}

function renderHistoryRow(ctx: ChangeRowContext, list: HTMLElement, item: ResolvedChange): void {
  const row = list.createDiv({ cls: "terminus-history-row" });
  row.createSpan({
    cls: item.accepted ? "terminus-diff-stat-add" : "terminus-diff-stat-remove",
    text: item.accepted ? "Kept" : "Reverted",
  });
  row.createSpan({ cls: "terminus-history-filename", text: pathBasename(item.diff.filePath) });
  row.createEl("button", { text: "Undo", cls: "terminus-btn-ghost-accent" }).addEventListener("click", () => {
    ctx.plugin.pendingChangesStore.undo(item.historyId).catch((err: unknown) => {
      new Notice(`Terminus: failed to undo: ${errorMessage(err)}`);
    });
  });
}
