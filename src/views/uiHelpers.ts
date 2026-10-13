import { setIcon } from "obsidian";

/**
 * Small building blocks shared by the Terminus sidebar and the Agent inbox,
 * so both use Obsidian's own icons (Lucide, via setIcon) and controls rather
 * than text glyphs, and both work from the keyboard the same way.
 */

/** An icon-only button in Obsidian's own style (`clickable-icon`), named
 *  for screen readers and tooltips. Its click doesn't reach the row. */
export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
  const button = parent.createEl("button", { cls: "clickable-icon terminus-icon-button", attr: { "aria-label": label } });
  setIcon(button, icon);
  button.addEventListener("click", (evt) => {
    evt.stopPropagation();
    onClick(evt);
  });
  return button;
}

/** A group's mark: a folder in the group's colour. Statuses are dots and a
 *  terminal's colour is a stroke, so a folder says "this is a group" without
 *  being mistaken for either. `color` is set on the span, which the CSS
 *  reads; a group's rows also set it on the row, so it may be omitted. */
export function groupIcon(parent: HTMLElement, color?: string | null): HTMLElement {
  const el = parent.createSpan({ cls: "terminus-group-icon" });
  if (color) el.style.setProperty("--terminus-group-color", color);
  setIcon(el, "folder");
  return el;
}

/** An icon followed by text, for the meta lines. */
export function iconLabel(parent: HTMLElement, icon: string, text: string, cls: string): HTMLElement {
  const el = parent.createSpan({ cls });
  setIcon(el.createSpan({ cls: "terminus-meta-icon" }), icon);
  el.createSpan({ text });
  return el;
}

/**
 * Makes a row work from the keyboard as it does with the mouse: focusable,
 * Enter or Space to activate, and the context-menu key or Shift+F10 for its
 * menu. Keys inside the row's own buttons and fields are theirs. Its
 * accessible name is its visible text: an aria-label would also become an
 * Obsidian hover tooltip on every row.
 */
export function makeActivatable(row: HTMLElement, activate: () => void, menu: (evt: MouseEvent) => void): void {
  row.setAttr("role", "button");
  row.setAttr("tabindex", "0");
  row.addEventListener("keydown", (evt) => {
    if (evt.target !== row) return;
    if (evt.key === "Enter" || evt.key === " ") {
      evt.preventDefault();
      activate();
    } else if (evt.key === "ContextMenu" || (evt.key === "F10" && evt.shiftKey)) {
      evt.preventDefault();
      const rect = row.getBoundingClientRect();
      menu(new MouseEvent("contextmenu", { clientX: rect.left + 24, clientY: rect.bottom }));
    }
  });
}
