/**
 * Automatic group names, from the clearest clue available: a linked note,
 * the first prompt sent in the group, the git branch, then the group's
 * folder. A clue only replaces a name from a weaker one, and a name the user
 * typed is never replaced (see GroupStore.autoName).
 *
 * Plain functions, no Obsidian: titles are made locally from text Terminus
 * already has, with no request to Claude or anywhere else.
 */

/** Where a group's name came from, weakest first. */
export type NameSource = "placeholder" | "folder" | "branch" | "prompt" | "note" | "user";

const STRENGTH: Record<NameSource, number> = { placeholder: 0, folder: 1, branch: 2, prompt: 3, note: 4, user: 5 };

/** Whether a name from `next` may replace one from `current`. The same
 *  source doesn't replace itself: the first prompt names the group. */
export function outranks(next: NameSource, current: NameSource): boolean {
  return current !== "user" && STRENGTH[next] > STRENGTH[current];
}

export const PLACEHOLDER_NAME = "New group";
const MAX_WORDS = 5;
const MAX_LENGTH = 40;

/** Openings that say nothing about the work. Longest first, lowercase. */
const FILLER = [
  "i would like you to",
  "i'd like you to",
  "i want you to",
  "i need you to",
  "can you please",
  "could you please",
  "would you please",
  "please can you",
  "hey claude",
  "hi claude",
  "can you",
  "could you",
  "would you",
  "help me",
  "let's",
  "lets",
  "please",
  "claude",
  "ok",
  "okay",
  "so",
];

/**
 * "Can you refactor the auth token rotation in api/session.ts?" becomes
 * "Refactor auth token rotation". Null for a prompt with nothing to name
 * from: a slash command, or too short once trimmed.
 */
export function titleFromPrompt(prompt: string): string | null {
  const firstLine = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (!firstLine || firstLine.startsWith("/")) return null;
  // The first sentence: the rest is usually detail.
  let text = (firstLine.split(/(?<=[.?!])\s/)[0] ?? firstLine).replace(/[.?!:;,]+$/, "");
  let lower = text.toLowerCase();
  for (let changed = true; changed; ) {
    changed = false;
    for (const filler of FILLER) {
      if (lower === filler || lower.startsWith(filler + " ") || lower.startsWith(filler + ",")) {
        text = text.slice(filler.length).replace(/^[\s,]+/, "");
        lower = text.toLowerCase();
        changed = true;
      }
    }
  }
  // Paths, @mentions and links make poor names; "the" adds nothing.
  const words = text
    .split(/\s+/)
    .filter((w) => w && !/[/\\]|^@|^https?:|\.\w{1,5}$/.test(w))
    .filter((w, i) => !(i > 0 && /^(the|a|an)$/i.test(w)));
  // Cut at a word that starts the detail ("in", "for"...) once there's enough.
  const detail = /^(in|on|for|from|to|with|at|so|because|using|via)$/i;
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length >= 2 && detail.test(word)) break;
    kept.push(word);
    if (kept.length === MAX_WORDS) break;
  }
  return finish(kept.join(" "));
}

/** "feature/auth-rotation" becomes "Auth rotation". Null for a trunk
 *  branch, which says nothing about this group in particular. */
export function titleFromBranch(branch: string): string | null {
  const name = branch.trim();
  if (!name || /^(main|master|trunk|develop|dev|HEAD)$/i.test(name)) return null;
  const last = name.split("/").pop() ?? name;
  return finish(last.replace(/[-_.]+/g, " "));
}

/** A folder relative to the vault, e.g. "projects/api". Null for the vault
 *  itself or a folder outside it. */
export function titleFromFolder(relativeFolder: string | null): string | null {
  if (!relativeFolder || relativeFolder === "." || relativeFolder.startsWith("..")) return null;
  return finish(relativeFolder.split("/").filter(Boolean).slice(-2).join("/"), false);
}

/** Trims, caps the length, and capitalises the first letter (sentence
 *  case). Null when too short to be a name. */
function finish(title: string, capitalise = true): string | null {
  let t = title.replace(/\s+/g, " ").trim();
  if (t.length > MAX_LENGTH) t = t.slice(0, MAX_LENGTH).replace(/\s+\S*$/, "") || t.slice(0, MAX_LENGTH);
  if (t.length < 2) return null;
  return capitalise ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}
