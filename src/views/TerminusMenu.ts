import { setIcon } from "obsidian";
import { tidySeparators, typeaheadMatch, type MenuEntry } from "./menuModel";

/**
 * Terminus's own menu, in place of Obsidian's Menu for the menus the plugin
 * opens itself. Obsidian's is a native macOS menu by default (no icons, no
 * styling); this one looks the same everywhere and can show what a native
 * menu can't: a label naming what the items act on, a line of description,
 * an icon in a group's colour.
 *
 * Its methods are the subset of Obsidian's Menu the plugin uses, so the
 * shared items in groupMenus.ts go into either: a terminal tab's menu and
 * the file menu are Obsidian's and stay that way.
 *
 * What a menu has to do, done here: one open at a time; anchored under the
 * button that opened it (or at the pointer) and kept on screen; ↑ ↓ Home End
 * to move, Enter or Space to choose, letters to jump, Escape or Tab to
 * close; focus back where it was; closed by a click elsewhere, a scroll, a
 * resize or the window losing focus; in whichever window it was opened from.
 */

/** What the shared menu items need from a menu item. Obsidian's MenuItem
 *  and TerminusMenuItem both fit. The optional ones only show in ours. */
export interface MenuItemLike {
  setTitle(title: string): this;
  setIcon(icon: string | null): this;
  setChecked(checked: boolean | null): this;
  setDisabled(disabled: boolean): this;
  setIsLabel(isLabel: boolean): this;
  onClick(callback: (evt: MouseEvent | KeyboardEvent) => unknown): this;
  /** A muted second line under the title. */
  setDescription?(description: string): this;
  /** The icon drawn in a colour, e.g. a group's. */
  setIconColor?(color: string): this;
}

/** What the shared menu items need from a menu: Obsidian's Menu and
 *  TerminusMenu both fit. */
export interface MenuLike {
  addItem(callback: (item: MenuItemLike) => unknown): this;
  addSeparator(): this;
}

export class TerminusMenuItem implements MenuItemLike {
  title = "";
  icon: string | null = null;
  iconColor: string | null = null;
  description: string | null = null;
  checked: boolean | null = null;
  disabled = false;
  isLabel = false;
  warning = false;
  callback: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;

  setTitle(title: string): this {
    this.title = title;
    return this;
  }
  setIcon(icon: string | null): this {
    this.icon = icon;
    return this;
  }
  setIconColor(color: string): this {
    this.iconColor = color;
    return this;
  }
  setDescription(description: string): this {
    this.description = description;
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.checked = checked;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  setIsLabel(isLabel: boolean): this {
    this.isLabel = isLabel;
    return this;
  }
  setWarning(warning: boolean): this {
    this.warning = warning;
    return this;
  }
  onClick(callback: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.callback = callback;
    return this;
  }
}

/** Where to put the menu: its top-left, and the y its bottom goes to when
 *  it doesn't fit below (the top of the button, or the pointer). */
interface Placement {
  x: number;
  y: number;
  flipY: number;
}

const MARGIN = 8;
/** Letters typed within this long of each other jump as one word. */
const TYPEAHEAD_MS = 700;

/** The menu showing now, if any: opening another closes it. */
let shown: TerminusMenu | null = null;

/**
 * The button whose press just closed its own menu, and when. A press on the
 * ⋯ that opened a menu is a press outside the menu, so it closes it; the
 * click that ends the same press would then open it again, and a second
 * click on ⋯ would seem to do nothing. So that click is swallowed instead.
 * Timed, so a press that wandered off and never clicked can't swallow a
 * later, real click on the same button.
 */
let closedByOpener: { button: HTMLElement; at: number } | null = null;
const OPENER_CLICK_MS = 1000;

export class TerminusMenu implements MenuLike {
  private entries: Array<MenuEntry<TerminusMenuItem>> = [];
  private hideCallbacks: Array<() => void> = [];
  private el: HTMLElement | null = null;
  /** The items that can take focus, in order (not labels). */
  private rows: Array<{ el: HTMLElement; item: TerminusMenuItem }> = [];
  private active = -1;
  private returnFocus: HTMLElement | null = null;
  /** The button that opened it, if a button did: shown as pressed while
   *  the menu is open, and pressing it again closes the menu. */
  private opener: HTMLElement | null = null;
  private teardown: Array<() => void> = [];
  private typed = "";
  private typedAt = 0;

  addItem(callback: (item: TerminusMenuItem) => unknown): this {
    const item = new TerminusMenuItem();
    callback(item);
    this.entries.push({ kind: "item", item });
    return this;
  }

  addSeparator(): this {
    this.entries.push({ kind: "separator" });
    return this;
  }

  onHide(callback: () => void): void {
    this.hideCallbacks.push(callback);
  }

  /**
   * Opened from a button (an iconButton's click): anchored under it, or
   * above when there's no room below. Otherwise (a right-click, or the
   * context-menu key through makeActivatable) at the pointer. A click from
   * the keyboard (Enter on a button, detail 0) starts on the first item, as
   * a native menu does; one from the mouse leaves the pointer to choose.
   */
  showAtMouseEvent(evt: MouseEvent): this {
    // A right-click's own menu (Electron's, if any) never shows over ours.
    if (evt.type === "contextmenu") evt.preventDefault();
    const target = evt.currentTarget;
    const button = target instanceof HTMLElement && target.tagName === "BUTTON" ? target : null;
    const node = button ?? (evt.target instanceof Node ? evt.target : null);
    const doc = node?.ownerDocument ?? activeDocument;
    const fromKeyboard = evt.detail === 0;
    if (button && closedByOpener?.button === button) {
      const justClosed = Date.now() - closedByOpener.at < OPENER_CLICK_MS;
      closedByOpener = null;
      // This click ends the press that just closed this button's menu.
      if (justClosed && !fromKeyboard) return this;
    }
    if (button) {
      this.opener = button;
      const rect = button.getBoundingClientRect();
      return this.show(doc, { x: rect.left, y: rect.bottom + 4, flipY: rect.top - 4 }, fromKeyboard);
    }
    return this.show(doc, { x: evt.clientX, y: evt.clientY, flipY: evt.clientY }, fromKeyboard);
  }

  showAtPosition(position: { x: number; y: number }, doc: Document = activeDocument): this {
    return this.show(doc, { x: position.x, y: position.y, flipY: position.y }, false);
  }

  /** Closes the menu; `restoreFocus` puts focus back where it was when the
   *  menu opened (not after a click elsewhere, which moved it on purpose). */
  close(restoreFocus = true): void {
    const el = this.el;
    if (!el) return;
    this.el = null;
    if (shown === this) shown = null;
    for (const undo of this.teardown) undo();
    this.teardown = [];
    el.remove();
    this.opener?.removeClass("is-menu-open");
    this.opener?.setAttr("aria-expanded", "false");
    this.opener = null;
    if (restoreFocus && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
    for (const callback of this.hideCallbacks) callback();
  }

  private show(doc: Document, at: Placement, focusFirst: boolean): this {
    shown?.close(false);
    const entries = tidySeparators(this.entries);
    if (!entries.some((entry) => entry.kind === "item" && !entry.item.isLabel)) return this;
    const win = doc.defaultView ?? activeWindow;
    this.returnFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

    const el = createDiv({ cls: "terminus-menu", attr: { role: "menu", tabindex: "-1" } });
    this.el = el;
    this.renderEntries(el, entries);
    // Appended before it's placed so its real size is known; nothing paints
    // until this block is done, so it never shows in the wrong place.
    doc.body.appendChild(el);
    const size = el.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(at.x, win.innerWidth - MARGIN - size.width));
    let top = at.y;
    if (top + size.height > win.innerHeight - MARGIN) top = at.flipY - size.height;
    top = Math.max(MARGIN, Math.min(top, win.innerHeight - MARGIN - size.height));
    el.setCssProps({ "--terminus-menu-x": `${left}px`, "--terminus-menu-y": `${top}px` });

    shown = this;
    this.opener?.addClass("is-menu-open");
    this.opener?.setAttr("aria-expanded", "true");
    this.listen(doc, win, el);
    if (focusFirst) this.moveTo(this.step(-1, 1));
    else el.focus({ preventScroll: true });
    return this;
  }

  private renderEntries(el: HTMLElement, entries: Array<MenuEntry<TerminusMenuItem>>): void {
    this.rows = [];
    // When any item has an icon, every item keeps an icon's space, so the
    // titles line up.
    const icons = entries.some((entry) => entry.kind === "item" && !entry.item.isLabel && entry.item.icon);
    for (const entry of entries) {
      if (entry.kind === "separator") {
        el.createDiv({ cls: "terminus-menu-separator", attr: { role: "separator" } });
        continue;
      }
      const { item } = entry;
      if (item.isLabel) {
        el.createDiv({ cls: "terminus-menu-label", text: item.title, attr: { role: "presentation" } });
        continue;
      }
      const row = el.createDiv({
        cls: "terminus-menu-item",
        attr: { role: item.checked === null ? "menuitem" : "menuitemcheckbox", tabindex: "-1" },
      });
      if (item.checked !== null) row.setAttr("aria-checked", String(item.checked));
      if (item.disabled) {
        row.addClass("is-disabled");
        row.setAttr("aria-disabled", "true");
      }
      row.toggleClass("is-warning", item.warning);
      if (icons) {
        const icon = row.createSpan({ cls: "terminus-menu-icon" });
        if (item.icon) setIcon(icon, item.icon);
        if (item.iconColor) icon.setCssProps({ "--terminus-menu-icon-color": item.iconColor });
      }
      const text = row.createSpan({ cls: "terminus-menu-text" });
      text.createSpan({ cls: "terminus-menu-title", text: item.title });
      if (item.description) text.createSpan({ cls: "terminus-menu-description", text: item.description });
      if (item.checked) setIcon(row.createSpan({ cls: "terminus-menu-check" }), "check");

      const index = this.rows.length;
      this.rows.push({ el: row, item });
      row.addEventListener("mousemove", () => {
        if (this.active !== index && !item.disabled) this.moveTo(index);
      });
      row.addEventListener("mouseleave", () => {
        if (this.active === index) this.moveTo(-1);
      });
      row.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.choose(index, evt);
      });
    }
  }

  private listen(doc: Document, win: Window, el: HTMLElement): void {
    const on = (target: EventTarget, type: string, handler: (evt: Event) => void, capture = false): void => {
      target.addEventListener(type, handler, capture);
      this.teardown.push(() => target.removeEventListener(type, handler, capture));
    };
    // A press anywhere else closes it. The press that opened it is over by
    // the time it shows (it opens on click or contextmenu), so this doesn't
    // catch its own opening.
    on(doc, "pointerdown", (evt) => {
      const target = evt.target instanceof Node ? evt.target : null;
      if (target && el.contains(target)) return;
      if (target && this.opener?.contains(target)) closedByOpener = { button: this.opener, at: Date.now() };
      this.close(false);
    }, true);
    // Focus moving anywhere outside it closes it too: a click into a view
    // that doesn't pass pointer events to this page (an agent's browser
    // view) still takes focus from the menu.
    on(el, "focusout", (evt) => {
      const next = (evt as FocusEvent).relatedTarget;
      if (next instanceof Node && el.contains(next)) return;
      // Null when focus goes nowhere in particular, e.g. a press on a part
      // of the window that takes no focus; the pointerdown above has that.
      if (next) this.close(false);
    });
    on(doc, "scroll", (evt) => {
      if (!(evt.target instanceof Node && el.contains(evt.target))) this.close(false);
    }, true);
    on(win, "resize", () => this.close(false));
    on(win, "blur", () => this.close(false));
    on(el, "contextmenu", (evt) => evt.preventDefault());
    on(el, "keydown", (evt) => this.onKey(evt as KeyboardEvent));
  }

  private onKey(evt: KeyboardEvent): void {
    const handled = (): void => {
      evt.preventDefault();
      evt.stopPropagation();
    };
    switch (evt.key) {
      case "ArrowDown":
        handled();
        this.moveTo(this.step(this.active, 1));
        return;
      case "ArrowUp":
        handled();
        this.moveTo(this.step(this.active < 0 ? this.rows.length : this.active, -1));
        return;
      case "Home":
        handled();
        this.moveTo(this.step(-1, 1));
        return;
      case "End":
        handled();
        this.moveTo(this.step(this.rows.length, -1));
        return;
      case "Enter":
      case " ":
        handled();
        if (this.active >= 0) this.choose(this.active, evt);
        return;
      case "Escape":
      case "Tab":
        handled();
        this.close();
        return;
    }
    if (evt.key.length === 1 && !evt.metaKey && !evt.ctrlKey && !evt.altKey) {
      handled();
      const now = Date.now();
      this.typed = now - this.typedAt > TYPEAHEAD_MS ? evt.key : this.typed + evt.key;
      this.typedAt = now;
      const titles = this.rows.map((row) => (row.item.disabled ? null : row.item.title));
      const match = typeaheadMatch(titles, this.active, this.typed);
      if (match >= 0) this.moveTo(match);
    }
  }

  /** The next item from `from` in direction `dir` that can be chosen,
   *  wrapping round; `from` may be -1 or rows.length to start at an end. */
  private step(from: number, dir: 1 | -1): number {
    const count = this.rows.length;
    for (let i = 1; i <= count; i++) {
      const index = (((from + dir * i) % count) + count) % count;
      if (!this.rows[index]?.item.disabled) return index;
    }
    return -1;
  }

  private moveTo(index: number): void {
    this.rows[this.active]?.el.removeClass("is-active");
    this.active = index;
    const row = this.rows[index];
    if (!row) {
      this.el?.focus({ preventScroll: true });
      return;
    }
    row.el.addClass("is-active");
    row.el.focus({ preventScroll: true });
    row.el.scrollIntoView({ block: "nearest" });
  }

  /** Closes first, so focus is back where it was before the action runs
   *  (a rename field or a modal then takes it from there). */
  private choose(index: number, evt: MouseEvent | KeyboardEvent): void {
    const row = this.rows[index];
    if (!row || row.item.disabled) return;
    this.close();
    row.item.callback?.(evt);
  }
}
