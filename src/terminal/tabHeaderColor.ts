import { ItemView, WorkspaceLeaf } from "obsidian";

/**
 * Tints a leaf's native tab header with a terminal's color tag, and forces
 * its title text to re-read getDisplayText() after a rename. Neither
 * `tabHeaderEl` nor `updateHeader()` is part of Obsidian's public API --
 * verified empirically against the current app bundle, not assumed, same
 * risk category as CommandTracker/CwdTracker's registerOscHandlerSafe
 * (src/terminal/oscHandler.ts) or getOsFilePath()'s webUtils fallback in
 * TerminalView.ts. Every reach here is optional-chained: on an Obsidian
 * version where this shape has changed, the native tab just silently keeps
 * whatever title/color it already had -- nothing throws.
 */
function getTabHeaderEl(leaf: WorkspaceLeaf): HTMLElement | undefined {
  return (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
}

export function refreshTabHeader(leaf: WorkspaceLeaf, color: string | null): void {
  const internal = leaf as unknown as { updateHeader?: () => void };
  internal.updateHeader?.();

  const tabHeaderEl = getTabHeaderEl(leaf);
  if (!tabHeaderEl) return;

  // A real appended child, not a ::before/::after -- verified against
  // Obsidian's own app.css that .workspace-tab-header already uses BOTH of
  // its own pseudo-elements for the decorative rounded tab corners (a
  // ::before/::after rule collides with them silently), and
  // .workspace-tab-header-inner has `overflow: hidden` with the outer
  // element's own padding insetting it ~4px from the tab's true edge (so
  // anything confined inside -inner can never reach that edge). A real
  // sibling of -inner, appended after it, needs neither pseudo-element nor
  // a z-index override: later DOM-order positioned children simply paint
  // on top per normal stacking rules, and it isn't a descendant of -inner
  // so its overflow:hidden doesn't clip it.
  let bar = tabHeaderEl.querySelector<HTMLElement>(":scope > .terminus-tab-color-bar");
  if (!bar) bar = tabHeaderEl.createDiv({ cls: "terminus-tab-color-bar" });
  bar.style.backgroundColor = color ?? "transparent";
}

/**
 * Toggles a small blinking dot on a leaf's native tab header, signaling that
 * this terminal needs attention (Claude is waiting on a permission prompt or
 * on idle input -- see TerminalView's onNeedsAttention/clearPendingAttention).
 * Same sibling-of-`-inner` placement as the color bar above and for the same
 * reason: it has to survive `-inner`'s `overflow: hidden` so it's still
 * visible once a crowded tab strip truncates the title text.
 *
 * Deliberately doesn't call `updateHeader()` the way refreshTabHeader does --
 * this can fire far more often than a rename or color change (every
 * Notification hook, every tab focus), and re-running Obsidian's own header
 * render on each one would be wasted work for a state change that's ours
 * alone.
 */
export function refreshTabPendingDot(leaf: WorkspaceLeaf, isPending: boolean): void {
  const tabHeaderEl = getTabHeaderEl(leaf);
  if (!tabHeaderEl) return;

  let dot = tabHeaderEl.querySelector<HTMLElement>(":scope > .terminus-tab-pending-dot");
  if (!dot) dot = tabHeaderEl.createDiv({ cls: "terminus-tab-pending-dot" });
  dot.toggleClass("is-pending", isPending);
}

/**
 * `leaf.updateHeader()` above only refreshes the tab strip -- confirmed
 * empirically (the tab title updates on rename, the pane's own header
 * title next to the pencil/palette actions doesn't). Reading Obsidian's own
 * renderer bundle confirms why: `View.titleEl` (the `.view-header-title`
 * element, not part of the public API) is only ever set once, in `load()`
 * (`this.titleEl.setText(this.getDisplayText())`) -- there's no built-in
 * hook that re-runs it on a later display-text change, so this calls the
 * exact same `setText()` Obsidian's own code uses, just triggered by us
 * instead of only at initial load. Optional-chained like the tab reach
 * above -- worst case the pane header just keeps its stale title. */
export function refreshPaneTitle(view: ItemView, displayText: string): void {
  const titleEl = (view as unknown as { titleEl?: HTMLElement }).titleEl;
  titleEl?.setText(displayText);
}
