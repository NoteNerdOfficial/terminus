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
  const win = doc.defaultView ?? window;
  const rect = anchorEl.getBoundingClientRect();

  const popover = doc.createElement("div");
  popover.addClass("terminus-color-picker-popover");

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

  // Appended (with no explicit position yet) before measuring so its real,
  // wrapped size is known -- the swatch grid wraps onto multiple rows via
  // CSS, so its width/height can't be predicted from swatch count alone.
  // Nothing paints until this synchronous block finishes, so positioning it
  // correctly here (rather than at rect.left/rect.bottom first, then
  // correcting) never produces a visible jump.
  doc.body.appendChild(popover);

  // Clamp to the viewport of the *anchor's* window, not the global
  // `window` -- Obsidian supports popped-out windows, and this popover must
  // stay on whichever screen its trigger button lives on. Anchored below
  // the button by default, flipped above it if it wouldn't fit; likewise
  // right-aligned/clamped horizontally instead of letting the right edge
  // (e.g. the button living in a narrow right-hand sidebar pane) run off
  // screen and cut off swatches.
  const margin = 8;
  const popRect = popover.getBoundingClientRect();

  let left = rect.left;
  if (left + popRect.width > win.innerWidth - margin) {
    left = win.innerWidth - margin - popRect.width;
  }
  left = Math.max(margin, left);

  let top = rect.bottom + 4;
  if (top + popRect.height > win.innerHeight - margin) {
    top = rect.top - popRect.height - 4;
  }
  top = Math.max(margin, top);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

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
