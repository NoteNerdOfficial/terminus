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
export function refreshTabHeader(leaf: WorkspaceLeaf, color: string | null): void {
  const internal = leaf as unknown as {
    tabHeaderEl?: HTMLElement;
    updateHeader?: () => void;
  };

  internal.updateHeader?.();

  const tabHeaderEl = internal.tabHeaderEl;
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
