/**
 * The parts of TerminusMenu that are plain logic, kept apart from the DOM so
 * they can be tested: which entries are shown, and which item typing
 * letters jumps to.
 */

export type MenuEntry<T> = { kind: "item"; item: T } | { kind: "separator" };

/** Separators only between items: none first, last, or twice in a row.
 *  Callers add a separator before an optional section, which may then add
 *  nothing (see groupMenus' addForkItem), so a menu would otherwise end on
 *  a rule or show two together. */
export function tidySeparators<T>(entries: ReadonlyArray<MenuEntry<T>>): Array<MenuEntry<T>> {
  const out: Array<MenuEntry<T>> = [];
  for (const entry of entries) {
    if (entry.kind === "separator" && (out.length === 0 || out[out.length - 1]?.kind === "separator")) continue;
    out.push(entry);
  }
  while (out[out.length - 1]?.kind === "separator") out.pop();
  return out;
}

/**
 * Typing letters in an open menu jumps to the next item whose title starts
 * with them, after the active one and wrapping round, as in a native menu.
 * `titles` lists the focusable items in order, null for a disabled one.
 * Returns the index to move to, or -1 when nothing matches.
 */
export function typeaheadMatch(titles: ReadonlyArray<string | null>, active: number, typed: string): number {
  const query = typed.toLowerCase();
  if (!query) return -1;
  // A repeated single letter cycles through the items starting with it;
  // a longer string can stay on the active item while it still matches.
  const from = query.length > 1 ? Math.max(active, 0) : active + 1;
  for (let step = 0; step < titles.length; step++) {
    const index = (from + step) % titles.length;
    const title = titles[index];
    if (title !== null && title !== undefined && title.toLowerCase().startsWith(query)) return index;
  }
  return -1;
}
