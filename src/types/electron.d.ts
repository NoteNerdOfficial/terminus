/**
 * Hand-declared surface for the two Electron APIs this plugin touches.
 *
 * Not `@types/electron`: pulling in the full package would drag Electron's
 * entire ambient type surface into a plugin that uses exactly two functions
 * from it, and ambient declarations are precisely what doesn't resolve
 * cleanly in the Obsidian review bot's checker -- the same problem that put
 * every Node core call behind the published `terminus-node-bridge` package.
 * Declaring only what's used keeps both call sites fully typed, so neither
 * needs a `require()` cast to reach them.
 *
 * "electron" is marked external in esbuild.config.mjs, so this import is
 * left for Obsidian's own desktop runtime to resolve rather than bundled.
 * Safe as a static import because the manifest sets `isDesktopOnly: true`;
 * both call sites still degrade gracefully if the API is missing.
 */
declare module "electron" {
  export const shell: {
    /** Resolves with an error *string* rather than rejecting -- empty on
     *  success. */
    openPath(path: string): Promise<string>;
  } | undefined;

  export const webUtils: {
    getPathForFile(file: File): string;
  } | undefined;
}
