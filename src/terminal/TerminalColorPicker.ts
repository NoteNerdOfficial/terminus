import { TERMINAL_COLOR_PALETTE } from "./colorPalette";

/**
 * Small anchored popover of color swatches, positioned off the triggering
 * button's own bounding rect -- same floating-DOM-node technique as
 * WikiLinkAutocomplete's popover, but mouse-driven (from an addAction
 * button) rather than keyboard-driven, so it needs its own outside-click/
 * Escape dismissal instead of routing through term.onData.
 */
export function openTerminalColorPicker(
  anchorEl: HTMLElement,
  currentColor: string | null,
  onSelect: (color: string | null) => void
): void {
  const doc = anchorEl.ownerDocument;
  const rect = anchorEl.getBoundingClientRect();

  const popover = doc.createElement("div");
  popover.addClass("terminus-color-picker-popover");
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  const addSwatch = (label: string, color: string | null) => {
    const swatch = popover.createDiv({ cls: "terminus-color-swatch" });
    swatch.setAttr("title", label);
    if (color) {
      swatch.style.backgroundColor = color;
    } else {
      swatch.addClass("terminus-color-swatch-none");
    }
    if (color === currentColor) swatch.addClass("is-selected");
    swatch.addEventListener("click", (evt) => {
      evt.stopPropagation();
      close();
      onSelect(color);
    });
  };

  addSwatch("None", null);
  for (const option of TERMINAL_COLOR_PALETTE) addSwatch(option.name, option.value);

  doc.body.appendChild(popover);

  // Deferred to the next tick -- the click that opened this popover (on
  // anchorEl) is still bubbling up to `doc` in this same event loop turn,
  // and would otherwise immediately trigger its own "outside click" check
  // and close the popover before the user ever sees it.
  const dismiss = (evt: MouseEvent | KeyboardEvent) => {
    if (evt instanceof KeyboardEvent && evt.key !== "Escape") return;
    if (evt instanceof MouseEvent && popover.contains(evt.target as Node)) return;
    close();
  };
  function close(): void {
    popover.remove();
    doc.removeEventListener("mousedown", dismiss);
    doc.removeEventListener("keydown", dismiss);
  }
  window.setTimeout(() => {
    doc.addEventListener("mousedown", dismiss);
    doc.addEventListener("keydown", dismiss);
  }, 0);
}
