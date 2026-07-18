/**
 * Fixed set of terminal color tags -- Obsidian's own `--color-*` theme
 * variables (introduced for colored tags) with hex fallbacks for older
 * Obsidian versions, same `var(--x, fallback)` defensive pattern already
 * used throughout src/css/custom.css.
 */
export interface TerminalColorOption {
  name: string;
  value: string;
}

export const TERMINAL_COLOR_PALETTE: TerminalColorOption[] = [
  { name: "Red", value: "var(--color-red, #e93147)" },
  { name: "Orange", value: "var(--color-orange, #e8871e)" },
  { name: "Yellow", value: "var(--color-yellow, #d4b106)" },
  { name: "Green", value: "var(--color-green, #08b94e)" },
  { name: "Cyan", value: "var(--color-cyan, #00bfbc)" },
  { name: "Blue", value: "var(--color-blue, #086ddd)" },
  { name: "Purple", value: "var(--color-purple, #7852ee)" },
  { name: "Pink", value: "var(--color-pink, #d53984)" },
];
