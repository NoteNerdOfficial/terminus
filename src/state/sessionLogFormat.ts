/**
 * How a session log note is written, as pure functions of plain data: no
 * Obsidian, no plugin, no clock of its own. Kept apart from SessionLog for
 * the same reason inboxModel is kept apart from the inbox view -- the exact
 * bytes that land in the user's vault can then be asserted directly.
 *
 * Everything here is deterministic. The same turn formats to the same text
 * every run, because nothing is summarised, inferred or sent to a model.
 */

/** A file as the note lists it. */
export interface LoggedFileView {
  /** Vault-relative inside the vault, else the absolute path. */
  path: string;
  /** Whether it can be written as a wikilink (in the vault, and with no
   *  character that would break one). */
  linkable: boolean;
  editCount: number;
  added: number;
  removed: number;
  /** "Explore", a subagent's task -- null for the lead session's own edit. */
  agentLabel: string | null;
}

/** Everything one appended turn section is built from. */
export interface TurnLogView {
  /** The turn's place in the session, counted from its own turn list so the
   *  numbering matches the Agent inbox's headers. */
  index: number;
  prompt: string | null;
  startedAt: number;
  endedAt: number | null;
  failed: boolean;
  /** The session ended before this turn's Stop arrived, so its edits are
   *  written from what was accumulated rather than from a finished turn. */
  unfinished: boolean;
  /** Claude's closing message, truncated as the store holds it. */
  lastMessage: string | null;
  files: LoggedFileView[];
  shellChanges: ShellChangeView[];
}

/** A file changed outside Claude's edit tools, as the note lists it. */
export interface ShellChangeView {
  /** Vault-relative inside the vault, else absolute -- as for a file row. */
  path: string;
  /** Already in words ("modified", "new"): the formatter does no decoding. */
  status: string;
}

export interface SessionHeaderView {
  sessionId: string | null;
  terminalName: string;
  startedAt: number;
  cwd: string | null;
  branch: string | null;
}


/** The note's frontmatter and heading, written once when it's created. */
export function formatSessionHeader(info: SessionHeaderView): string {
  const lines = ["---", 'terminus-session-status: active'];
  if (info.sessionId) lines.push(`terminus-session-id: ${yaml(info.sessionId)}`);
  lines.push(`terminus-terminal: ${yaml(info.terminalName)}`);
  lines.push(`terminus-started: ${localIso(info.startedAt)}`);
  if (info.cwd) lines.push(`terminus-folder: ${yaml(info.cwd)}`);
  if (info.branch) lines.push(`terminus-branch: ${yaml(info.branch)}`);
  lines.push("---", "");
  lines.push(`# Session log — ${info.terminalName}`, "");
  lines.push("> [!info] Written by Terminus, one entry per turn");
  lines.push("> Prompts, files and timings exactly as Claude Code's hooks reported them.");
  lines.push("> Nothing here is written by a model, and nothing is inferred.", "");
  lines.push(`- **Started** ${clock(info.startedAt, true)}`);
  if (info.cwd) lines.push(`- **Folder** \`${info.cwd}\``);
  if (info.branch) lines.push(`- **Branch** \`${info.branch}\``);
  lines.push("");
  return lines.join("\n");
}

/** One turn's section, appended when the turn ends. */
export function formatTurnSection(turn: TurnLogView): string {
  const duration = turn.endedAt === null ? null : formatDuration(turn.endedAt - turn.startedAt);
  const heading = [`## Turn ${turn.index}`, clock(turn.startedAt, false), duration, turn.failed ? "failed" : null, turn.unfinished ? "unfinished" : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const lines = ["", heading, ""];

  if (turn.prompt) lines.push(blockquote(turn.prompt), "");

  if (turn.failed && turn.lastMessage) {
    lines.push("> [!failure] The turn ended with an error", blockquote(turn.lastMessage, ">"), "");
  }

  if (turn.files.length === 0) {
    lines.push("No files changed.", "");
  } else {
    lines.push("| File | Change |", "| --- | --- |");
    for (const file of turn.files) {
      const name = file.linkable ? `[[${file.path}]]` : `\`${escapeCell(file.path)}\``;
      // " · " rather than ", ": a subagent's task runs to a sentence, and
      // comma-joined it reads as part of the diff rather than as who made it.
      const detail = [
        `+${file.added} −${file.removed}`,
        file.editCount > 1 ? `${file.editCount} edits` : null,
        file.agentLabel ? `via ${escapeCell(file.agentLabel)}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ");
      lines.push(`| ${name} | ${detail} |`);
    }
    lines.push("");
  }

  if (turn.unfinished) {
    lines.push("_The session ended before this turn finished, so it may have changed more than this._", "");
  }

  if (turn.shellChanges.length > 0) {
    lines.push("**Changed outside Claude's edit tools:**");
    for (const change of turn.shellChanges) {
      lines.push(`- \`${change.path}\` (${change.status})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** The closing line, appended when the session ends. */
export function formatSessionClosing(totals: { turns: number; files: number; activeMs: number; endedAt: number }): string {
  const parts = [
    `**Session ended** ${clock(totals.endedAt, true)}`,
    `${totals.turns} ${totals.turns === 1 ? "turn" : "turns"}`,
    `${totals.files} ${totals.files === 1 ? "file" : "files"}`,
    `${formatDuration(totals.activeMs)} working`,
  ];
  return `\n---\n\n${parts.join(" · ")}\n`;
}

/** The user's text, verbatim, as a blockquote: every line prefixed so a
 *  prompt with blank lines, lists or headings in it can't break out of the
 *  quote and restructure the note. */
function blockquote(text: string, marker = ">"): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `${marker} ${line}` : marker))
    .join("\n");
}

/** A table cell: a pipe would start a new column, a backtick would close
 *  the code span the path sits in. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/`/g, "'");
}

/** A double-quoted YAML scalar, safe for a path or a name with a colon, a
 *  quote or a backslash in it. Newlines and tabs are escaped rather than
 *  passed through: a raw newline inside the quotes would end the value and
 *  let a renamed terminal write its own frontmatter keys. */
function yaml(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

/** Local time as "2026-10-20T14:05:12", which Obsidian and Bases both read
 *  as a date. Deliberately not toISOString(), which would shift a late
 *  evening session onto the next day in UTC. */
export function localIso(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** "14:22", or "2026-10-20 14:22" with the date. */
function clock(at: number, withDate: boolean): string {
  const iso = localIso(at);
  return withDate ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 16);
}

/** "2026-10-20 1405", the note's name. */
export function stamp(at: number): string {
  const iso = localIso(at);
  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/** A terminal's name as a file name: the characters Obsidian won't take in
 *  one become hyphens, and a name that reduces to nothing drops out. */
export function safeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|[\]#^]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60);
}

/** Matches the inbox's own durations (see AgentInboxView.formatDuration). */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
