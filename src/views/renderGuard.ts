import type { Component } from "obsidian";

/**
 * Holds a view's re-render while a mouse button is down inside it.
 *
 * A browser fires `click` only when the press and the release land on the
 * same element. These views rebuild their DOM on store and workspace events,
 * and pressing inside one can itself cause such an event (the sidebar
 * becoming the active pane), so a rebuild between press and release swaps
 * the element out and the click is lost: the user has to click twice. A
 * render asked for mid-press runs once the button is released, after the
 * click has been delivered.
 *
 * Returns the guarded render to hand to listeners in place of `render`.
 */
export function guardRenderDuringPress(component: Component, el: HTMLElement, render: () => void): () => void {
  let pressed = false;
  let queued = false;
  // The primary button only: a right-click opens a menu, which (natively, on
  // macOS) swallows the release, so the hold would last until the next click
  // anywhere, e.g. leaving "Rename" waiting for one.
  component.registerDomEvent(el, "pointerdown", (evt) => {
    if (evt.button === 0) pressed = true;
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    if (!queued) return;
    queued = false;
    // After the click event that follows this pointerup.
    window.setTimeout(render, 0);
  };
  // On the window: the button may be released outside the view.
  component.registerDomEvent(window, "pointerup", release);
  component.registerDomEvent(window, "pointercancel", release);
  return () => {
    if (pressed) {
      queued = true;
      return;
    }
    render();
  };
}
