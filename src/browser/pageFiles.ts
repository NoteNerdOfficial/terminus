import { pathDirname, pathRelative } from "terminus-node-bridge";

/**
 * Whether a change to `changed` can change the page built from `source`
 * (both absolute paths): the file itself, or, for an HTML page, a file in
 * its folder or below, which is where its stylesheets and scripts are.
 * Notes there aren't part of the page, and a page at the top of the vault
 * would otherwise reload for every edit anywhere in it.
 */
export function pageDependsOn(source: string, changed: string, vaultBases: string[]): boolean {
  if (changed === source) return true;
  if (!/\.html?$/i.test(source) || /\.md$/i.test(changed)) return false;
  const folder = pathDirname(source);
  if (vaultBases.includes(folder)) return false;
  const relative = pathRelative(folder, changed);
  return relative !== "" && !relative.startsWith("..") && !/^([a-zA-Z]:|[\\/])/.test(relative);
}
