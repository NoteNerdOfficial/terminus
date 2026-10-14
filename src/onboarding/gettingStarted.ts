import { Platform } from "obsidian";
import { MULTI_AGENT_AVAILABLE } from "../settings";

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
  return `Terminus is a real terminal, inside Obsidian. Run Claude Code alongside your notes, and every file it edits comes back to you, so you can keep the change or undo it.

#### Nothing Claude writes is final

No more hunting for "where did that change happen." Each file it edits shows up in one Pending Changes panel, or on its session's card in Multi-agent (what changed, where, and by how much), with a real line-numbered diff per file and Accept / Reject / Open right there.

#### Typing shortcuts

| Shortcut | Does |
| --- | --- |
| \`Ctrl\` \`U\` | Clear the whole line |
| \`${k.alt}\` \`${k.backspace}\` | Delete the previous word |
| \`${k.alt}\` \`←\` / \`→\` | Jump a word at a time |
| \`Ctrl\` \`A\` / \`Ctrl\` \`E\` | Jump to the start / end of the line |
| \`Shift\` \`Enter\` | New line without submitting |

#### Your vault, from the prompt

| Action | Does |
| --- | --- |
| \`${k.mod}\` + click | Open a file path or URL from the output |
| Type \`[[\` | Autocomplete a note from your vault |
| Drag a file in | Inserts its path, ready to run |

${
    MULTI_AGENT_AVAILABLE
      ? `#### Running Claude in several terminals?

Terminus opens in the Multi-agent experience: an Agent inbox with a card per Claude session, and groups for your terminals. Prefer one Pending Changes panel? Switch to Classic in Settings → Terminus → Experience.

`
      : ""
  }Everything else — reviewing diffs, colored terminals, settings — is in the full guide.`;
}

/** The full reference, reachable any time from the command palette. */
export function buildGettingStartedMarkdown(): string {
  const k = keys();
  return `Terminus is a real terminal, inside Obsidian. Run Claude Code alongside your notes and every file it edits comes back to you, so you can keep the change or undo it.

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
${
    MULTI_AGENT_AVAILABLE
      ? `
## Choosing an experience

Terminus has two. They share your terminals, pending changes and nearly every setting; they differ in how you keep track of Claude's work.

- **Multi-agent** (the default) adds an **Agent inbox** with a card per Claude session, and **groups** for your terminals. Best when you run several sessions at once. The Multi-agent section below covers it.
- **Classic** is one **Pending Changes** panel, grouped by terminal. Best for one session at a time.

Switch any time in **Settings → Terminus → Experience**. Each keeps its own review settings, and nothing is lost when you switch.
`
      : ""
  }
## Reviewing Claude's changes

This is what Terminus is really for. ${MULTI_AGENT_AVAILABLE ? "The steps below describe Classic's Pending Changes panel; in Multi-agent the same changes sit on each session's card in the Agent inbox, with the same Keep / Reject, inline diff and Split Diff." : ""}

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

${
    MULTI_AGENT_AVAILABLE
      ? `## Multi-agent

Run several Claude sessions side by side without losing track of them. If you'd rather have one Pending Changes panel, switch to Classic in **Settings → Terminus → Experience**.

### Groups (left sidebar)

- **A group is one piece of work.** It holds the terminals for that task, plus the notes you have open in it. Selecting a group shows only its terminals; the others keep running in the background. Terminals outside any group show in every group.
- **At a glance.** A group's row says what is happening in it: needs attention, N working, N to review, or when its last turn finished. Click "N to review" to open the inbox at that terminal.
- **Link a note.** A group can link to a note and show its \`status\`. When a turn ends with the note \`active\`, Terminus suggests moving it to \`review\`; it never changes the note on its own.
- **Settle or snooze.** *Settle* puts a finished group on a Done shelf without closing its terminals; it comes back when a session in it starts working or needs you. *Snooze* hides a group until a time you pick, and brings it back sooner if a session needs you.
- **Organise.** Drag terminals between groups, drag a group to reorder it, and \`${k.mod}\`-click terminals then **Group selected** to gather them.
- **Go anywhere.** **Go to terminal or group…** is a fuzzy picker over everything, urgent ones first.

### The Agent inbox (right sidebar)

A card per Claude session, sorted into **Needs attention**, **Working** and **Finished**. Each shows what the session is doing (or its closing message), how long its turn took, its git branch, and tokens and an estimated cost. Its pending changes are listed under whoever made them: the lead or a subagent.

The inbox follows the selected group; sessions in other groups are listed in one line each under **Elsewhere**. **Next** jumps to the next session that needs you.

### Tell a running session something

Each card has a box with three ways to deliver a message:

- **Steer** types it into the session's input line and presses Enter. Claude folds it into the turn it is working on.
- **Queue** holds it until the turn ends, then sends it.
- **Add to input** types it for you to read and send yourself.

\`${k.mod}\` \`Enter\` does your default (**Settings → Terminus → Default for messages to a running session**) and \`${k.mod}\` \`Shift\` \`Enter\` does the other. Steering works mid-turn and is refused only while Claude waits on a prompt.

Queued messages appear above the box in the order they will go. Drag to reorder, edit one in place, remove it, or promote it with **Steer**. When a turn ends the next one is sent, one per turn, unless Claude is waiting on a prompt or the last turn failed (the card says why). The queue is saved with the terminal, so it survives a restart and comes back paused with a **Resume** button.

### More from a card

- **Send a task to a new terminal.** Opens a new Claude session beside the sender with your prompt typed in, unsent. Its result shows on the sender's card, and one click types it back into the sender's input.
- **Fork a session.** Starts a new terminal in the same group that continues from this session's conversation.
- **Review feedback.** Comment on a hunk in Split Diff, queue comments per session, and send them to that session between turns.
- **Resume after a restart.** Terminals that had Claude running pick the same conversation back up when Obsidian reopens (turn off in settings).

`
      : ""
  }## Working with your vault

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
- **Automatically reveal Pending Changes.** Plus how long to wait after a burst of edits before it comes forward.${
    MULTI_AGENT_AVAILABLE
      ? `
- **Experience.** Multi-agent or Classic.
- **Default for messages to a running session.** What \`${k.mod}\` \`Enter\` does in an inbox card: steer or queue.
- **Resume Claude sessions on reopen**, **Track subagents**, and **Show estimated cost.**`
      : ""
  }

---

Reopen this any time with the **Terminus: Getting started** command.`;
}
