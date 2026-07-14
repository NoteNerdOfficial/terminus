import { readTextFileIfExists } from "../node/fs";
import { PreToolUseHookPayload } from "../hooks/types";

export interface DiffResult {
  filePath: string;
  oldText: string;
  newText: string;
  existedBefore: boolean;
  /** Exact bytes to restore the file to if the change is rejected. For
   *  Edit/Write this equals oldText; for NotebookEdit it's the real
   *  original file (oldText/newText there are a display-only approximation,
   *  since it isn't a full valid notebook), so revertText must be captured
   *  separately to avoid corrupting the file on reject. */
  revertText: string;
}

async function readIfExists(filePath: string): Promise<{ text: string; existed: boolean }> {
  const text = await readTextFileIfExists(filePath);
  return text === null ? { text: "", existed: false } : { text, existed: true };
}

export async function buildDiff(payload: PreToolUseHookPayload): Promise<DiffResult> {
  if (payload.tool_name === "Edit") {
    const { file_path, old_string, new_string, replace_all } = payload.tool_input;
    const { text: oldText, existed } = await readIfExists(file_path);
    const newText = replace_all
      ? oldText.split(old_string).join(new_string)
      : oldText.replace(old_string, new_string);
    return { filePath: file_path, oldText, newText, existedBefore: existed, revertText: oldText };
  }

  if (payload.tool_name === "Write") {
    const { file_path, content } = payload.tool_input;
    const { text: oldText, existed } = await readIfExists(file_path);
    return { filePath: file_path, oldText, newText: content, existedBefore: existed, revertText: oldText };
  }

  // Best-effort for v1: no reliable way to reconstruct the full post-edit
  // notebook JSON from just one cell's new source, so the *display* diff is
  // an approximation. revertText is NOT approximate: it's the real original
  // file, read here before the write happens, so Reject can restore exact
  // bytes rather than writing a display placeholder into a JSON file.
  const { notebook_path, new_source } = payload.tool_input;
  const { text: originalNotebookText, existed } = await readIfExists(notebook_path);
  return {
    filePath: notebook_path,
    oldText: "(cell diffing not yet implemented -- showing new source only)",
    newText: new_source,
    existedBefore: existed,
    revertText: originalNotebookText,
  };
}
