import { deleteFileIfExists, makeDirRecursive, pathJoin, readTextFileIfExists, writeTextFile } from "terminus-node-bridge";

/** Marks the skill file as Terminus's own, so turning agent control off
 *  removes only a file Terminus wrote, never one the user replaced. */
const MARKER = "<!-- Written by the Terminus plugin. Turning off agent control removes this file. -->";

/** Taught to Claude through `.claude/skills/terminus/SKILL.md` in the vault
 *  while agent control is on. */
export const SKILL_MD = `---
name: terminus
description: Control the Terminus terminal you're running in (an Obsidian plugin) -- open terminals beside you, run commands in them and read their output, notify the user, and message, wait on or delegate work to other Claude sessions in your group. Use when TERMINUS_CLI is set and a task would benefit from a separate terminal (a dev server, a watcher, a long test run), from parallel work in another Claude session, or from telling the user something needs them.
---

${MARKER}

# Terminus

You're running inside a Terminus terminal in Obsidian when \`TERMINUS_CLI\` is set. Run \`"$TERMINUS_CLI" <command>\` with your Bash tool. Every command prints JSON (\`read\` and \`result\` print text). Errors go to stderr with a code and exit 1.

You can only see and reach terminals in your own group. Terminals have ids like \`t3\`; \`whoami\` shows yours.

If a command fails with \`disabled\`, the user hasn't turned on agent control. Don't retry; tell them it's in Terminus settings → Agent control.

## Terminals

\`\`\`bash
"$TERMINUS_CLI" whoami
"$TERMINUS_CLI" list
"$TERMINUS_CLI" open --name server --command "npm run dev"     # also: --placement tab|split-right|split-down, --cwd DIR
"$TERMINUS_CLI" wait-output t5 "ready in" --timeout 60          # --regex for a regular expression
"$TERMINUS_CLI" read t5 --lines 50
"$TERMINUS_CLI" run t5 "npm test"                               # a shell terminal only, not one running Claude
"$TERMINUS_CLI" close t5                                        # only terminals you opened
\`\`\`

\`wait-output\` searches the screen, which includes the command line itself: \`echo ready\` matches "ready" before it has printed anything. Match the output with \`--regex\` anchors (\`"^ready$"\`) or text the command line doesn't contain.

Open a terminal for anything long-running you'd otherwise background, so the user can see it. Close what you opened when you're done with it.

## Other Claude sessions

\`\`\`bash
"$TERMINUS_CLI" delegate "Summarize the notes in Projects/ into Projects/Overview.md" --name overview
"$TERMINUS_CLI" prompt t4 "Can you check the links in Overview.md?"   # --now to steer its current turn
"$TERMINUS_CLI" wait t4 --next-turn --timeout 100
"$TERMINUS_CLI" result t4
\`\`\`

- \`delegate\` starts a new Claude session with the task and sends its result back to you on its own: it arrives as a new message once you're between turns. Don't poll for it; end your turn if you have nothing else to do.
- \`prompt\` queues a message for a session, delivered once its current turn ends (\`--now\` types it into the running turn instead). The message says it came from you and your terminal id, so the other session can reply with \`prompt\`.
- \`wait\` returns when the session is \`done\`, \`idle\`, \`blocked\` (waiting on the user) or \`ended\`; with \`--next-turn\`, when its next turn finishes. Keep \`--timeout\` under 110 seconds and call again if it times out.
- Statuses: \`working\`, \`blocked\`, \`done\`, \`idle\`, \`ended\`, \`none\` (a plain shell).
- Never message a session in a loop, and don't start more than one or two helpers for a task. You can't type into a session that's waiting on a permission prompt; that's the user's to answer.

## Telling the user

\`\`\`bash
"$TERMINUS_CLI" status "Running the full test suite"   # shown on your inbox card until your turn ends
"$TERMINUS_CLI" notify "Tests finished: 2 failures" --title "Tests"
\`\`\`

Notify only for something the user would want to be interrupted for.

## Limits

Terminus won't start anything with permission checks bypassed. A terminal you opened can't open more. Opens, runs, prompts and delegations are rate-limited.
`;

function skillPath(vaultBasePath: string): string {
  return pathJoin(vaultBasePath, ".claude", "skills", "terminus", "SKILL.md");
}

/** Writes the skill while agent control is on, and removes Terminus's own
 *  copy when it's off. A file the user edited keeps the marker and is
 *  overwritten on the next write; one without the marker is theirs. */
export async function provisionSkill(vaultBasePath: string, enabled: boolean): Promise<void> {
  const path = skillPath(vaultBasePath);
  const existing = await readTextFileIfExists(path);
  if (!enabled) {
    if (existing?.includes(MARKER)) await deleteFileIfExists(path);
    return;
  }
  if (existing !== null && !existing.includes(MARKER)) return;
  if (existing === SKILL_MD) return;
  await makeDirRecursive(pathJoin(vaultBasePath, ".claude", "skills", "terminus"));
  await writeTextFile(path, SKILL_MD);
}
