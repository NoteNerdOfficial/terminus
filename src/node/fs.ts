import { existsSync } from "fs";
import * as fsPromises from "fs/promises";
import * as nodePath from "path";
import { randomBytes } from "crypto";

/**
 * Every filesystem/path/crypto touchpoint in the plugin goes through this
 * one file, exporting hand-declared signatures rather than re-exporting
 * Node's own (ambient, environment-dependent) types -- see the sibling
 * files in src/node/ and reference_obsidian_plugin_release_process memory
 * for why.
 */

export function pathJoin(...segments: string[]): string {
  return nodePath.join(...segments);
}

export function pathBasename(filePath: string, ext?: string): string {
  return nodePath.basename(filePath, ext);
}

export function pathDirname(filePath: string): string {
  return nodePath.dirname(filePath);
}

export function pathRelative(from: string, to: string): string {
  return nodePath.relative(from, to);
}

export function fileExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/** Returns the file's text content, or null if it doesn't exist. Rethrows
 *  any other error (permissions, etc.) rather than masking it as "missing". */
export async function readTextFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await fsPromises.writeFile(filePath, content, "utf8");
}

export async function appendTextFile(filePath: string, content: string): Promise<void> {
  await fsPromises.appendFile(filePath, content, "utf8");
}

export async function makeDirRecursive(dirPath: string): Promise<void> {
  await fsPromises.mkdir(dirPath, { recursive: true });
}

/** No-op if the file doesn't already exist. */
export async function deleteFileIfExists(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

export function randomHex(byteLength: number): string {
  return randomBytes(byteLength).toString("hex");
}
