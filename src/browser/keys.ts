import type { KeyModifier } from "terminus-node-bridge";

/**
 * Key names as an agent writes them ("Enter", "Shift+Tab", "Control+a",
 * "ArrowDown", "x"), following the DOM's KeyboardEvent.key as Playwright's
 * do, turned into what Electron's sendInputEvent takes. That, not the
 * debugging protocol's Input.dispatchKeyEvent, is what reaches the page
 * without going to whatever has focus in Obsidian instead.
 */

export interface KeyStroke {
  /** Electron's accelerator name for the key ("Enter", "Up", "a"). */
  electronKey: string;
  /** The character the key types, if any ("" for Tab, arrows, shortcuts). */
  text: string;
  modifiers: KeyModifier[];
}

const MODIFIERS: Record<string, KeyModifier> = {
  alt: "alt",
  option: "alt",
  control: "control",
  ctrl: "control",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  shift: "shift",
};

const NAMED: Record<string, { electronKey: string; text?: string }> = {
  enter: { electronKey: "Enter", text: "\r" },
  tab: { electronKey: "Tab" },
  escape: { electronKey: "Escape" },
  esc: { electronKey: "Escape" },
  backspace: { electronKey: "Backspace" },
  delete: { electronKey: "Delete" },
  space: { electronKey: "Space", text: " " },
  arrowup: { electronKey: "Up" },
  arrowdown: { electronKey: "Down" },
  arrowleft: { electronKey: "Left" },
  arrowright: { electronKey: "Right" },
  home: { electronKey: "Home" },
  end: { electronKey: "End" },
  pageup: { electronKey: "PageUp" },
  pagedown: { electronKey: "PageDown" },
  insert: { electronKey: "Insert" },
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = { electronKey: `F${i}` };

/** Throws an Error naming what it didn't understand. */
export function parseKey(spec: string): KeyStroke {
  if (!spec) throw new Error("No key given");
  // "+" on its own, or as the last part ("Shift++"), is the plus key.
  const parts = spec === "+" ? ["+"] : spec.endsWith("++") ? [...spec.slice(0, -2).split("+"), "+"] : spec.split("+");
  const keyPart = parts.pop() ?? "";
  const modifiers: KeyModifier[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part.trim().toLowerCase()];
    if (modifier === undefined) throw new Error(`Unknown modifier "${part}" (use Alt, Control, Meta or Shift)`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  // A shortcut types nothing.
  const shortcut = modifiers.some((m) => m !== "shift");
  const shift = modifiers.includes("shift");

  const named = NAMED[keyPart.toLowerCase()];
  if (named && keyPart.length > 1) return { electronKey: named.electronKey, text: shortcut ? "" : (named.text ?? ""), modifiers };
  if ([...keyPart].length !== 1) throw new Error(`Unknown key "${keyPart}" (use a single character or a name like Enter, Tab, Escape, ArrowDown)`);

  let key = keyPart;
  if (/^[a-z]$/i.test(key) && shift) key = key.toUpperCase();
  const electronKey = key === "+" ? "Plus" : key === " " ? "Space" : key;
  return { electronKey, text: shortcut ? "" : key, modifiers };
}
