/**
 * Terminal color tags. The first 8 are Obsidian's own `--color-*` theme
 * variables (introduced for colored tags) with hex fallbacks for older
 * Obsidian versions, same `var(--x, fallback)` defensive pattern already
 * used throughout src/css/custom.css -- these track the user's Obsidian
 * theme automatically. The rest fill gaps Obsidian's own tag-color set
 * doesn't cover; there's no matching theme variable for them, so they're
 * literal hex values that won't shift with theme changes.
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
  { name: "Teal", value: "#12a594" },
  { name: "Indigo", value: "#3559e8" },
  { name: "Magenta", value: "#c026d3" },
  { name: "Lime", value: "#83b311" },
  { name: "Brown", value: "#a1662f" },
  { name: "Gray", value: "#8a8f98" },
];
