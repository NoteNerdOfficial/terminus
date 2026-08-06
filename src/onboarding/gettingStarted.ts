import { Platform } from "obsidian";

/**
 * Onboarding copy, bundled rather than fetched.
 *
 * Some plugins pull their "what's new" panel from a URL at load time, which
 * buys the ability to change the text between releases. It also means a
 * network request on every startup, content that can change after review
 * without being reviewed again, and nothing at all for an offline user.
 * None of that is worth it here: this text only changes when the plugin
 * itself changes, which already implies a release.
 */

/** macOS-vs-rest key naming, applied to the copy below rather than left as
 *  a generic "modifier" -- a shortcut table that doesn't name the actual key
 *  isn't much of a shortcut table. */
function keys() {
  const mac = Platform.isMacOS;
  return {
    mod: mac ? "Cmd" : "Ctrl",
    alt: mac ? "Opt" : "Alt",
    backspace: mac ? "⌫" : "Backspace",
  };
}

/**
 * First-run modal. Deliberately short: an onboarding panel gets dismissed
 * in a few seconds whatever it says, so it carries only the handful of
 * things nobody discovers on their own, and defers everything else to the
 * full guide behind a button.
 */
export function buildWelcomeMarkdown(): string {
  const k = keys();
  return `A terminal that lives in your vault, with Claude Code's edits held for review before they stick.

#### Editing a long line

You don't have to hold backspace:

| Shortcut | Does |
| --- | --- |
| \`Ctrl\` \`U\` | Clear the whole line |
| \`${k.alt}\` \`${k.backspace}\` | Delete the previous word |
| \`${k.alt}\` \`←\` / \`→\` | Jump a word at a time |
| \`Ctrl\` \`A\` / \`Ctrl\` \`E\` | Jump to start / end of line |
| \`Shift\` \`Enter\` | New line without submitting |

#### In the terminal

| Action | Does |
| --- | --- |
| \`${k.mod}\` + click | Open a file path or URL from the output |
| Type \`[[\` | Autocomplete a note from your vault |
| Drag a file in | Inserts its path, ready to run |

Claude's edits land in the **Pending Changes** panel, where you keep or revert them file by file.`;
}

/** The full reference, reachable any time from the command palette. */
export function buildGettingStartedMarkdown(): string {
  const k = keys();
  return `A terminal that lives in your vault, with Claude Code's edits held for review before they stick.

## Keyboard

Terminus passes these straight through to your shell, so they work at a plain prompt and inside Claude Code alike.

| Shortcut | Does |
| --- | --- |
| \`Ctrl\` \`U\` | Clear the whole line |
| \`Ctrl\` \`W\` | Delete the previous word |
| \`${k.alt}\` \`${k.backspace}\` | Delete the previous word |
| \`${k.alt}\` \`←\` / \`→\` | Jump a word at a time |
| \`Ctrl\` \`A\` / \`Ctrl\` \`E\` | Jump to start / end of line |
| \`Ctrl\` \`C\` | Cancel what's running |
| \`Shift\` \`Enter\` | New line without submitting, for multi-line prompts to Claude |
| \`${k.mod}\` + click | Open a file path or URL printed in the output |

Font size has its own commands: **Increase / Decrease / Reset terminal font size**.

## Reviewing Claude's changes

This is what Terminus is really for.

When Claude edits a file, the edit goes through immediately. Nothing is blocked, so a long multi-file turn never stalls waiting on you. What Terminus captures is the *before* state, so every change stays reversible.

1. A live **"editing…"** chip appears in the bottom-right of the terminal, naming the file being written, for as long as the turn runs.
2. Once the burst settles, the **Pending Changes** panel comes to front.
3. Review each file, then **Keep** or **Revert** it.

Two ways to read a diff:

- **Inline.** **Open** opens the file, landing on the first changed hunk. On a note the change is marked up in the editor, so you can accept or reject in place; anything else — a code file another plugin opens, an image, a PDF — just opens normally.
- **Split Diff.** A side-by-side view, with its own Accept/Reject on each changed block. It renders from the text the hook captured rather than the file, so it works even for dot-files and paths outside the vault.

Bulk actions (**Keep all** / **Reject all**) are available per-terminal or globally, and every one of them is undoable from the **Recently resolved** list. If you'd rather be asked first, turn on *Confirm before bulk actions* in settings.

The **Action Log** command shows every change you've kept or reverted, with line counts.

### Broken links

If Claude renames or moves a note, Terminus checks whether anything in your vault linked to it and flags the breakage on the pending change, so a tidy-up doesn't quietly sever your backlinks.

## Working with your vault

- **Type \`[[\`** in the terminal to autocomplete a note name from your vault. Choose the format it inserts (wiki-link, vault-relative path, or absolute path) in settings.
- **Drag a file in** from Obsidian's file explorer or from Finder. Its path is typed into the input line, not run, so you can finish the command yourself.
- **\`${k.mod}\` + click a path** in the output to open that file. A trailing \`:42\` jumps to the line. Anything Obsidian can't open — a dot-file, a path outside the vault — opens in your system's default app instead.
- **\`${k.mod}\` + click a URL** to open it in your browser.

## Managing terminals

Open as many as you like. Each runs its own \`claude\` session, and their reviews stay separate.

- **Rename** a terminal with the pencil icon in its pane header — the bar with the terminal's name, above the terminal itself.
- **Color** it with the palette icon next to it. The color carries through to the tab, the activity chip, and its group in Pending Changes — useful once several are running.
- **Rescue closed terminal** brings back one you closed by mistake, with its scrollback and working directory.
- Terminals **survive a restart**: scrollback and working directory are restored, with a fresh shell.

## When a command fails

A failed command gets a **⚠** badge next to it. Click it and Claude reads the surrounding commands, not just the failed one, and proposes a fix.

The suggestion is typed into your input line. It never runs on its own; you read it and press Enter.

## Settings worth a look

- **Startup command.** Run something in every new terminal automatically. Set it to \`claude\` to skip a step every time.
- **New terminal placement.** New tab, split, or window, instead of being asked each time.
- **Font family.** Monospace fonts detected on your system.
- **Scrollback.** How much history each terminal keeps.
- **Automatically reveal Pending Changes.** Plus how long to wait after a burst of edits before it comes forward.

---

Reopen this any time with the **Terminus: Getting started** command.`;
}
