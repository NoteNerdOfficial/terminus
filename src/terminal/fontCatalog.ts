/**
 * Monospace fonts worth offering in the settings dropdown, filtered at
 * display time down to the ones actually installed (see
 * listAvailableMonospaceFonts).
 *
 * The list is deliberately monospace-only. A terminal paints every glyph
 * into a fixed-width cell whose size is measured once from a reference
 * glyph, so a proportional font (Inter, say) sizes the grid to its widest
 * character and leaves every narrow one floating in a too-wide cell -- the
 * "letters are miles apart" symptom. That isn't tunable: shrinking the cell
 * to suit narrow glyphs would break the column alignment the grid exists
 * for. The only real fix is not to pick a proportional font, which is what
 * a curated list makes the default outcome rather than a lucky one.
 */
const CANDIDATE_MONOSPACE_FONTS = [
  // Bundled with an OS -- at least one of these resolves nearly everywhere.
  "Menlo",
  "Monaco",
  "SF Mono",
  "Consolas",
  "Cascadia Code",
  "Cascadia Mono",
  "Courier New",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
  // Commonly installed by developers.
  "JetBrains Mono",
  "Fira Code",
  "Fira Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Roboto Mono",
  "Inconsolata",
  "Hack",
  "Iosevka",
  "Victor Mono",
  "Space Mono",
  "Anonymous Pro",
  "Cousine",
  "PT Mono",
  // Ships with powerlevel10k's installer, so it's widespread among exactly
  // the shell-prompt users most likely to notice glyph problems.
  "MesloLGS NF",
];

/** Wide enough that a per-glyph width difference of a fraction of a pixel
 *  still accumulates past floating-point noise. */
const MEASURE_FONT_SIZE = 72;

/** Mixes wide and narrow glyphs so a proportional font's width variance has
 *  somewhere to show up. */
const MEASURE_TEXT = "mmmmmmmmmmlli";

/** Generic families to measure against. A font is judged present if it
 *  changes the rendered width away from *any* of these -- one base alone
 *  gives false negatives whenever the missing font happens to fall back to
 *  that very base. */
const BASE_FAMILIES = ["monospace", "sans-serif", "serif"];

function createMeasureContext(): CanvasRenderingContext2D | null {
  // Never attached to the DOM -- it exists only to measure text widths.
  return createEl("canvas").getContext("2d");
}

function measureWidth(ctx: CanvasRenderingContext2D, family: string, text: string): number {
  ctx.font = `${MEASURE_FONT_SIZE}px ${family}`;
  return ctx.measureText(text).width;
}

/** Quoted so a multi-word family name ("Fira Code") is parsed as one family
 *  rather than a list, and any embedded quote can't break out of the CSS
 *  font shorthand this gets interpolated into. */
function quoteFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "")}"`;
}

/**
 * Whether a font is actually installed.
 *
 * Not `document.fonts.check()`: that reports whether a font is *loaded and
 * ready*, not whether the system can resolve it, and returns true for
 * names that don't exist. The canvas-measurement comparison below is the
 * long-standing way to get a truthful answer -- if naming the family
 * changes the rendered width away from the generic base it would otherwise
 * fall back to, the family resolved to something real.
 */
export function isFontAvailable(family: string, ctx?: CanvasRenderingContext2D | null): boolean {
  const context = ctx ?? createMeasureContext();
  if (!context) return false;
  const quoted = quoteFamily(family);
  return BASE_FAMILIES.some(
    (base) => measureWidth(context, `${quoted}, ${base}`, MEASURE_TEXT) !== measureWidth(context, base, MEASURE_TEXT)
  );
}

/**
 * Whether a font renders every glyph at the same width. Used to warn on a
 * hand-entered family rather than to filter the curated list (which is
 * monospace by construction).
 */
export function isFontMonospaced(family: string, ctx?: CanvasRenderingContext2D | null): boolean {
  const context = ctx ?? createMeasureContext();
  if (!context) return true; // can't measure -- don't cry wolf
  const quoted = quoteFamily(family);
  const narrow = measureWidth(context, `${quoted}, monospace`, "i");
  const wide = measureWidth(context, `${quoted}, monospace`, "W");
  // Sub-pixel differences show up even in genuinely monospaced fonts due to
  // hinting, so compare with a tolerance rather than for exact equality.
  return Math.abs(narrow - wide) < 0.5;
}

/** The curated list, minus anything not installed on this machine -- an
 *  entry that silently falls back to another font would look like the
 *  setting did nothing. */
export function listAvailableMonospaceFonts(): string[] {
  const ctx = createMeasureContext();
  if (!ctx) return [];
  return CANDIDATE_MONOSPACE_FONTS.filter((family) => isFontAvailable(family, ctx));
}
