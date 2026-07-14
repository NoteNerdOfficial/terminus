import { App, TFile } from "obsidian";

export interface BrokenBacklink {
  sourceFile: string;
  fragment: string;
  isBlock: boolean;
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/gm;
const BLOCK_ID_RE = /\^([a-zA-Z0-9-]+)\s*$/gm;

function extractHeadings(text: string): Set<string> {
  const headings = new Set<string>();
  for (const m of text.matchAll(HEADING_RE)) {
    const heading = m[1];
    if (heading !== undefined) headings.add(heading.trim());
  }
  return headings;
}

function extractBlockIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(BLOCK_ID_RE)) {
    const id = m[1];
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/**
 * Best-effort: flags [[Note#Heading]] or [[Note#^block]] backlinks whose
 * target heading/block existed in oldText but is gone from newText. Uses
 * the public resolvedLinks map (there's no public getBacklinksForFile API)
 * plus each backlinking file's own link cache to recover which specific
 * fragment each link targets. Old/new headings and block IDs are parsed
 * directly from the diff's own text (not Obsidian's cache for this file,
 * which may not have re-indexed yet immediately after a write) -- only
 * *other* files' caches are read, which are unaffected by this edit.
 */
export function detectBacklinkBreakage(app: App, targetFile: TFile, oldText: string, newText: string): BrokenBacklink[] {
  const oldHeadings = extractHeadings(oldText);
  const newHeadings = extractHeadings(newText);
  const oldBlocks = extractBlockIds(oldText);
  const newBlocks = extractBlockIds(newText);

  if (oldHeadings.size === 0 && oldBlocks.size === 0) return [];

  const broken: BrokenBacklink[] = [];
  const { metadataCache } = app;

  for (const [sourcePath, destinations] of Object.entries(metadataCache.resolvedLinks)) {
    if (!(targetFile.path in destinations)) continue;

    const cache = metadataCache.getCache(sourcePath);
    for (const link of cache?.links ?? []) {
      const hashIdx = link.link.indexOf("#");
      if (hashIdx === -1) continue; // plain file link, nothing to break

      const notePart = link.link.slice(0, hashIdx);
      const resolved = metadataCache.getFirstLinkpathDest(notePart, sourcePath);
      if (!resolved || resolved.path !== targetFile.path) continue;

      const fragment = link.link.slice(hashIdx + 1);
      if (fragment.startsWith("^")) {
        const blockId = fragment.slice(1);
        if (oldBlocks.has(blockId) && !newBlocks.has(blockId)) {
          broken.push({ sourceFile: sourcePath, fragment: blockId, isBlock: true });
        }
      } else if (oldHeadings.has(fragment) && !newHeadings.has(fragment)) {
        broken.push({ sourceFile: sourcePath, fragment, isBlock: false });
      }
    }
  }

  return broken;
}
