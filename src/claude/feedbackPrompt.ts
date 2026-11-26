import type { ReviewIntent } from "../browser/review";
import type { FeedbackItem } from "../state/FeedbackStore";

/** What each type asks of Claude, for a comment on selected note text. */
const INTENT_FOR_CLAUDE: Record<ReviewIntent, string> = {
  change: "Change",
  question: "Question: answer it, don't change the file for it",
  keep: "Keep: leave these lines as they are",
};

/** Excerpt lines per item: enough to place the hunk, short enough that the
 *  prompt stays readable in the terminal before it's sent. */
const MAX_EXCERPT_LINES = 6;

/**
 * The prompt that carries a session's queued review comments back to
 * Claude. It's typed into the terminal's input line and never submitted
 * (see TerminalView.typeIntoInput), so it's written for the user to read
 * and edit as much as for Claude.
 *
 * `relativePath` turns an absolute path into the one Claude should see
 * (vault-relative, as the session's own edits were made from the vault).
 */
export function composeFeedbackPrompt(items: FeedbackItem[], relativePath: (absolute: string) => string): string {
  const lines: string[] = [heading(items), ""];
  items.forEach((item, i) => {
    const type = item.intent ? ` [${INTENT_FOR_CLAUDE[item.intent]}]` : "";
    lines.push(`${i + 1}. ${relativePath(item.filePath)}, ${describeLocation(item)}${item.rejected ? ". I rejected this change and reverted it" : ""}${type}`);
    for (const line of excerptLines(item.excerpt)) lines.push(`   > ${line}`);
    const comment = item.comment.trim();
    if (comment) for (const line of comment.split("\n")) lines.push(`   ${line}`);
    lines.push("");
  });
  lines.push(items.length === 1 ? "Please address it." : "Please address each item.");
  // Claude Code's input treats \r as Enter: none may reach the terminal.
  return lines.join("\n").replace(/\r/g, "");
}

function heading(items: FeedbackItem[]): string {
  const onEdits = items.every((item) => !item.intent);
  if (onEdits) return items.length === 1 ? "Feedback on one of your edits:" : "Feedback on your edits:";
  const onNotes = items.every((item) => item.intent);
  if (onNotes) return items.length === 1 ? "A review comment on my notes:" : "Review comments on my notes:";
  return "Review comments:";
}

function describeLocation(item: FeedbackItem): string {
  const range = item.rejected ? (item.oldLines ?? item.newLines) : (item.newLines ?? item.oldLines);
  if (!range) return "an edit";
  // A comment on selected note text: lines of the note as it is now.
  if (item.intent) return range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`;
  // A rejected hunk's lines are back to the original, so they're numbered
  // as the original was; a kept or pending one as Claude's version.
  const side = item.rejected || !item.newLines ? "the original" : "your version";
  const span = range.start === range.end ? `line ${range.start}` : `lines ${range.start}–${range.end}`;
  return `${span} of ${side}`;
}

function excerptLines(excerpt: string): string[] {
  const all = excerpt.replace(/\r/g, "").replace(/\n$/, "").split("\n");
  if (all.length <= MAX_EXCERPT_LINES) return all;
  return [...all.slice(0, MAX_EXCERPT_LINES), `… (${all.length - MAX_EXCERPT_LINES} more lines)`];
}
