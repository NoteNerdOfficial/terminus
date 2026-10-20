import { describe, it } from "node:test";
import assert from "node:assert";
import {
  formatSessionBase,
  formatSessionHeader,
  formatTurnSection,
  formatSessionClosing,
  safeFileName,
  stamp,
  localIso,
  type TurnLogView,
  type LoggedFileView,
} from "../src/state/sessionLogFormat";

/**
 * The exact text a session log note is made of. These are pure functions of
 * their input, which is the whole reason they live apart from the vault I/O:
 * what lands in someone's vault can be asserted byte for byte.
 *
 * The escaping cases matter most. A prompt is the user's own text, written
 * verbatim, so it must not be able to restructure the note it sits in.
 */

const AT = new Date(2026, 9, 20, 14, 5, 12).getTime();
const TURN_AT = new Date(2026, 9, 20, 14, 22, 0).getTime();

const file = (over: Partial<LoggedFileView> = {}): LoggedFileView => ({
  path: "src/a.ts",
  linkable: true,
  editCount: 1,
  added: 12,
  removed: 4,
  agentLabel: null,
  ...over,
});

const turn = (over: Partial<TurnLogView> = {}): TurnLogView => ({
  index: 3,
  prompt: "Fix the folder folding",
  startedAt: TURN_AT,
  endedAt: TURN_AT + 108_000,
  failed: false,
  unfinished: false,
  lastMessage: null,
  files: [file()],
  shellChanges: [],
  ...over,
});

describe("session log format: determinism", () => {
  it("renders the same input to the same bytes", () => {
    assert.equal(formatTurnSection(turn()), formatTurnSection(turn()));
  });

  it("leaks no raw timestamps into the text", () => {
    assert.ok(!/\d{13}/.test(formatTurnSection(turn())), "no epoch millis in the output");
  });
});

describe("session log format: header", () => {
  it("writes queryable frontmatter and a local-time start", () => {
    const header = formatSessionHeader({
      sessionId: "abc-123",
      terminalName: "Terminus 1",
      startedAt: AT,
      cwd: "/repo",
      branch: "main",
      goal: "Rewrite the pricing page",
    });
    assert.ok(header.startsWith("---\n"), "frontmatter opens the note");
    assert.ok(header.includes('terminus-goal: "Rewrite the pricing page"'), "the goal is queryable");
    assert.ok(header.includes("- **Goal** Rewrite the pricing page"), "and readable in the note");
    assert.ok(header.includes("terminus-session-status: active"));
    assert.ok(header.includes("terminus-started: 2026-10-20T14:05:12"), "local time, not UTC-shifted");
    assert.ok(header.includes("# Session log — Terminus 1"));
    assert.ok(header.includes("> [!info]"), "a callout says it was machine-written");
  });

  it("omits facts it does not have rather than writing them blank", () => {
    const header = formatSessionHeader({ sessionId: null, terminalName: "T", startedAt: AT, cwd: null, branch: null, goal: null });
    assert.ok(!header.includes("terminus-folder"));
    assert.ok(!header.includes("terminus-branch"));
    assert.ok(!header.includes("terminus-session-id"));
    assert.ok(!header.includes("terminus-goal"));
    assert.ok(!header.includes("**Goal**"));
  });

  it("stops a terminal name from injecting its own frontmatter keys", () => {
    const header = formatSessionHeader({
      sessionId: null,
      terminalName: 'Bad"\nterminus-session-status: ended\nsneaky: yes',
      startedAt: AT,
      cwd: null,
      branch: null,
      goal: null,
    });
    const lines = header.split("---")[1]!.split("\n");
    const keys = lines.filter((line) => /^[a-zA-Z0-9_-]+:/.test(line)).map((line) => line.split(":")[0]);
    assert.deepEqual(keys, ["terminus-session-status", "terminus-terminal", "terminus-started"]);
    assert.ok(!keys.includes("sneaky"), "the injected key is inert text inside the quoted value");
  });
});

describe("session log format: a turn", () => {
  it("renders the heading, the prompt and a linked file table", () => {
    const section = formatTurnSection(turn());
    assert.ok(section.includes("## Turn 3 · 14:22 · 1m 48s"));
    assert.ok(section.includes("> Fix the folder folding"), "the prompt is quoted");
    assert.ok(section.includes("| [[src/a.ts]] | +12 −4 |"), "an in-vault file is a wikilink");
  });

  it("stops a prompt from breaking out of its blockquote", () => {
    const hostile = "Line one\n\n---\n# Injected heading\n\n| a | b |\n> quote";
    const section = formatTurnSection(turn({ prompt: hostile }));
    const lines = section.split("\n");
    assert.ok(!lines.some((line) => line === "---"), "a --- line cannot open frontmatter");
    assert.ok(!lines.some((line) => line.startsWith("# ")), "a heading stays inside the quote");
  });

  it("stops a prompt from forging a turn heading", () => {
    // SessionLog recovers a note's turn count by reading these headings, so
    // a prompt that could forge one would corrupt the numbering on restart.
    const section = formatTurnSection(turn({ prompt: "## Turn 99\nplease renumber me" }));
    const headings = [...section.matchAll(/^## Turn (\d+)/gm)].map((m) => m[1]);
    assert.deepEqual(headings, ["3"], "only the real heading");
  });

  it("escapes a path that would break the table, and never links it", () => {
    const section = formatTurnSection(turn({ files: [file({ path: "weird|name.ts", linkable: false })] }));
    assert.ok(section.includes("weird\\|name.ts"), "the pipe is escaped");
    assert.ok(!section.includes("[[weird|name.ts]]"), "an unlinkable path is not wikilinked");
  });

  it("shows out-of-vault paths as code spans", () => {
    const section = formatTurnSection(turn({ files: [file({ path: "/etc/hosts", linkable: false })] }));
    assert.ok(section.includes("`/etc/hosts`"));
  });

  it("records repeat edits and which subagent made them", () => {
    const section = formatTurnSection(turn({ files: [file({ editCount: 3, agentLabel: "Explore" })] }));
    assert.ok(section.includes("3 edits"));
    assert.ok(section.includes("via Explore"));
  });

  it("still records a turn that changed nothing", () => {
    const section = formatTurnSection(turn({ files: [] }));
    assert.ok(section.includes("No files changed."));
    assert.ok(section.includes("## Turn 3"), "so the numbering stays honest");
  });

  it("marks a failed turn and keeps its error", () => {
    const section = formatTurnSection(turn({ failed: true, lastMessage: "model_not_found" }));
    assert.ok(section.includes("· failed"));
    assert.ok(section.includes("> [!failure]"));
    assert.ok(!section.includes("unfinished"), "failed and unfinished are different states");
  });

  it("marks an unfinished turn without inventing a duration", () => {
    const section = formatTurnSection(turn({ endedAt: null, unfinished: true }));
    assert.ok(section.includes("## Turn 3 · 14:22 · unfinished"));
    assert.ok(section.includes("ended before this turn finished"));
    assert.ok(section.includes("[[src/a.ts]]"), "its edits are still listed in full");
    assert.ok(!section.includes("undefined") && !section.includes("NaN"));
  });

  it("lists the turn's shell changes with their status", () => {
    const section = formatTurnSection(turn({ shellChanges: [{ path: "package-lock.json", status: "modified" }] }));
    assert.ok(section.includes("Changed outside Claude's edit tools"));
    assert.ok(section.includes("`package-lock.json` (modified)"));
  });
});

describe("session log format: closing line and names", () => {
  it("carries the session totals", () => {
    const closing = formatSessionClosing({ turns: 4, files: 9, activeMs: 31 * 60_000, endedAt: AT });
    assert.ok(closing.startsWith("\n---\n"), "separated from the last turn");
    assert.ok(closing.includes("**Session ended** 2026-10-20 14:05"));
    assert.ok(closing.includes("4 turns · 9 files · 31m 0s working"));
  });

  it("uses singulars for one", () => {
    const closing = formatSessionClosing({ turns: 1, files: 1, activeMs: 5000, endedAt: AT });
    assert.ok(closing.includes("1 turn · 1 file"));
  });

  it("makes a terminal name safe as a file name", () => {
    assert.equal(safeFileName("feature/turn-grouping"), "feature-turn-grouping", "slashes can't make folders");
    assert.equal(safeFileName('a:b*c?d"e<f>g|h'), "a-b-c-d-e-f-g-h");
    assert.equal(safeFileName("  ..trim-me..  "), "trim-me");
    assert.equal(safeFileName("a\u0000b\u001fc"), "abc", "control characters removed");
    assert.ok(safeFileName("x".repeat(200)).length <= 60, "long names are capped");
  });

  it("stamps and formats dates in local time", () => {
    assert.equal(stamp(AT), "2026-10-20 1405");
    assert.equal(localIso(AT), "2026-10-20T14:05:12", "a late session does not slip to the next day");
  });
});

describe("session log format: the goal line", () => {
  const withGoal = (goal: string) =>
    formatSessionHeader({ sessionId: null, terminalName: "T", startedAt: AT, cwd: null, branch: null, goal });

  it("never lets a prompt turn the log into a link to the note it mentioned", () => {
    const header = withGoal("Rewrite [[Pricing page]] and [[Navigation]]");
    assert.ok(!header.includes("[["), "no wikilink survives, in the property or the summary line");
    assert.ok(header.includes("Rewrite Pricing page and Navigation"), "the words are kept");
  });

  it("keeps a goal with a colon inside its property", () => {
    const header = withGoal("Fix: the pricing page");
    const line = header.split("\n").find((l) => l.startsWith("terminus-goal:"))!;
    assert.equal(line, 'terminus-goal: "Fix: the pricing page"');
  });
});

describe("session log format: the Bases view", () => {
  it("offers the three views over the properties the notes actually write", () => {
    const base = formatSessionBase();
    for (const name of ["Recent", "Unfinished", "By branch"]) {
      assert.ok(base.includes(`name: ${name}`), `${name} view`);
    }
    for (const property of ["terminus-goal", "terminus-terminal", "terminus-branch", "terminus-turns", "terminus-session-status"]) {
      assert.ok(base.includes(property), `${property} is shown`);
    }
    assert.ok(base.includes('file.hasProperty("terminus-session-id")'), "scoped to this log's own notes");
  });

  it("indexes hyphenated properties inside filter expressions, never dots them", () => {
    // `note.terminus-session-status == "active"` is read as arithmetic on
    // three names: it matches nothing and reports no error, so the view just
    // comes up empty. Verified in Obsidian 1.14; this guards the fix.
    for (const line of formatSessionBase().split("\n")) {
      if (!line.includes("==")) continue;
      assert.ok(!/note\.[a-z]+-/.test(line), `filter must index, not dot: ${line.trim()}`);
    }
    assert.ok(formatSessionBase().includes('note["terminus-session-status"] == "active"'));
  });
});
