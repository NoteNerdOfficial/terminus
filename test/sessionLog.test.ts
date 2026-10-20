import { describe, it } from "node:test";
import assert from "node:assert";
import { SessionLog } from "../src/state/SessionLog";
import { AgentSessionStore } from "../src/state/AgentSessionStore";
import { makeVault, makePlugin, fakeDiff, identity, settle, type FakeVault } from "./helpers/fakeVault";

/**
 * The session log's lifecycle: which note a session writes to, how its turns
 * are numbered, and what happens at the three ways a session can end (Stop,
 * /clear, and being killed outright).
 *
 * Numbering in particular has broken twice -- once past the agent store's
 * 50-turn cap, once across a restart -- and neither time did the typechecker
 * or the build notice. That is what these are here for.
 */

function setup(vault?: FakeVault) {
  const v = vault ?? makeVault();
  const store = new AgentSessionStore();
  const log = new SessionLog(makePlugin(store, v.app));
  return { vault: v, store, log };
}

/** One complete turn: prompt, a single edit, Stop, and its log section. */
async function runTurn(
  log: SessionLog,
  store: AgentSessionStore,
  sessionId: string,
  promptId: string,
  prompt: string,
  filePath: string,
  at: number
) {
  store.promptSubmitted("tok", identity(sessionId), prompt, promptId, at);
  log.noteEdit("tok", fakeDiff(filePath), promptId, null);
  store.turnEnded("tok", "done", identity(sessionId), at + 60_000, false, promptId);
  await log.appendTurn("tok", promptId, []);
}

function start(log: SessionLog, store: AgentSessionStore, sessionId: string) {
  store.sessionStarted("tok", identity(sessionId));
  log.sessionStarted("tok", sessionId);
}

describe("session log: one note per session", () => {
  it("writes every turn to the same note, in order", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "First request", "/vault/a.md", 1000);
    await runTurn(log, store, "S1", "p2", "Second request", "/vault/b.md", 200_000);
    await runTurn(log, store, "S1", "p3", "Third request", "/vault/c.md", 400_000);
    await settle();

    const note = vault.onlyNote();
    assert.deepEqual(vault.turnNumbers(), [1, 2, 3]);
    for (const prompt of ["First request", "Second request", "Third request"]) {
      assert.ok(note.data.includes(prompt), `${prompt} is recorded`);
    }
    assert.ok(note.data.indexOf("First request") < note.data.indexOf("Third request"), "oldest turn first");
  });

  it("creates no note at all for a session that never finishes a turn", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    log.noteEdit("tok", fakeDiff("/vault/a.md"), "p1", null);
    await settle();
    assert.equal(vault.files.size, 0, "nothing is written before a turn ends");
  });

  it("numbers 55 turns 1..55, past the agent store's 50-turn cap", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    for (let i = 1; i <= 55; i++) {
      await runTurn(log, store, "S1", `p${i}`, `Request ${i}`, `/vault/f${i}.md`, i * 100_000);
    }
    await settle();

    const numbers = vault.turnNumbers();
    assert.equal(numbers.length, 55, "every turn is written");
    assert.deepEqual(numbers, Array.from({ length: 55 }, (_, i) => i + 1), "strictly 1..55");
    assert.equal(new Set(numbers).size, 55, "no repeated turn numbers");
  });
});

describe("session log: /clear", () => {
  it("starts a new note and closes the old one off", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "Work in the first session", "/vault/a.md", 1000);

    // TerminalView resets the agent store BEFORE telling the log, so the
    // closing write must not depend on it. Reproduced in that order here.
    store.sessionStarted("tok", identity("S2"));
    log.sessionStarted("tok", "S2");
    await runTurn(log, store, "S2", "p9", "Work in the second session", "/vault/b.md", 500_000);
    await settle();

    assert.equal(vault.notes().length, 2, "a cleared conversation gets its own note");

    const first = vault.notes().find((f) => f.data.includes("Work in the first session"))!;
    assert.ok(first.data.includes("**Session ended**"), "the cleared session's note is closed off");
    assert.equal(vault.frontmatter.get(first.path)!["terminus-session-status"], "ended");
    assert.equal(vault.frontmatter.get(first.path)!["terminus-turns"], 1, "its totals are recorded");

    const second = vault.notes().find((f) => f.data.includes("Work in the second session"))!;
    assert.ok(!second.data.includes("Work in the first session"), "the sessions don't share a note");
    assert.deepEqual(vault.turnNumbers(second), [1], "the new session numbers from 1");
  });
});

describe("session log: restart", () => {
  it("continues the same note and keeps numbering", async () => {
    const vault = makeVault();
    const before = setup(vault);
    start(before.log, before.store, "S1");
    await runTurn(before.log, before.store, "S1", "p1", "Before the restart", "/vault/a.md", 1000);
    await runTurn(before.log, before.store, "S1", "p2", "Also before", "/vault/b.md", 200_000);
    await settle();

    // A restart: brand-new plugin objects, same Claude session resumed.
    const after = setup(vault);
    start(after.log, after.store, "S1");
    await runTurn(after.log, after.store, "S1", "p3", "After the restart", "/vault/c.md", 900_000);
    await settle();

    assert.equal(vault.notes().length, 1, "one session, one note -- no restart split");
    assert.deepEqual(vault.turnNumbers(), [1, 2, 3], "numbering continues rather than restarting at 1");
    assert.ok(vault.onlyNote().data.includes("After the restart"));
  });
});

describe("session log: a session that is killed", () => {
  it("writes the in-flight turn's edits and marks it unfinished", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "A finished turn", "/vault/a.md", 1000);

    // A turn that starts and edits, but whose Stop never arrives.
    store.promptSubmitted("tok", identity("S1"), "An interrupted turn", "p2", 300_000);
    log.noteEdit("tok", fakeDiff("/vault/killed.md"), "p2", null);
    await log.endSession("tok");
    await settle();

    const note = vault.onlyNote();
    assert.ok(note.data.includes("killed.md"), "its edits are written, not dropped");
    assert.ok(note.data.includes("An interrupted turn"), "its prompt is recorded");
    assert.deepEqual(vault.turnNumbers(), [1, 2], "it gets the next turn number");
    assert.ok(note.data.includes("unfinished"), "and is marked as unfinished");
    assert.ok(
      note.data.indexOf("**Session ended**") > note.data.indexOf("killed.md"),
      "the closing line still comes last"
    );
  });
});

describe("session log: abandoned notes", () => {
  it("marks a note left active by a killed Obsidian, without touching its body", async () => {
    const vault = makeVault();
    const first = setup(vault);
    start(first.log, first.store, "S1");
    await runTurn(first.log, first.store, "S1", "p1", "Work before the crash", "/vault/a.md", 1000);
    await runTurn(first.log, first.store, "S1", "p2", "More work", "/vault/b.md", 200_000);
    await settle();

    const note = vault.onlyNote();
    const bodyBefore = note.data;
    assert.equal(vault.frontmatter.get(note.path)!["terminus-session-status"], "active", "active mid-session");

    // Obsidian is killed: endSession never runs. The next launch sweeps.
    const next = setup(vault);
    await next.log.sweepAbandoned();

    const fm = vault.frontmatter.get(note.path)!;
    assert.equal(fm["terminus-session-status"], "abandoned");
    assert.equal(fm["terminus-turns"], 2, "turn count recovered from the note's own headings");
    assert.equal(fm["terminus-ended"], undefined, "no end time is invented");
    assert.equal(note.data, bodyBefore, "the body is never rewritten -- frontmatter only");
  });

  it("revives an abandoned note when its session comes back", async () => {
    const vault = makeVault();
    const first = setup(vault);
    start(first.log, first.store, "S1");
    await runTurn(first.log, first.store, "S1", "p1", "Before", "/vault/a.md", 1000);
    await settle();

    const next = setup(vault);
    await next.log.sweepAbandoned();
    assert.equal(vault.frontmatter.get(vault.onlyNote().path)!["terminus-session-status"], "abandoned");

    // `claude --resume` keeps the session id, so the note is adopted back.
    start(next.log, next.store, "S1");
    await runTurn(next.log, next.store, "S1", "p2", "Back again", "/vault/b.md", 900_000);
    await settle();

    assert.equal(vault.notes().length, 1, "still one note");
    assert.equal(vault.frontmatter.get(vault.onlyNote().path)!["terminus-session-status"], "active", "revived");
    assert.deepEqual(vault.turnNumbers(), [1, 2], "numbering continues after the sweep");
  });

  it("never marks a session that is still running", async () => {
    const { vault, store, log } = setup();
    start(log, store, "LIVE");
    await runTurn(log, store, "LIVE", "p1", "Running right now", "/vault/a.md", 1000);
    await settle();

    await log.sweepAbandoned();
    assert.equal(vault.frontmatter.get(vault.onlyNote().path)!["terminus-session-status"], "active");
  });
});

describe("session log: a turn that fails", () => {
  it("writes the failed turn's own edits under it, not as a phantom turn at the end", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "A finished turn", "/vault/a.md", 1000);

    // A turn that rewrites one file and then hits an API error. StopFailure
    // is not known to carry a prompt_id, so TerminalView asks the store
    // which turn is open before closing it; this is that order.
    store.promptSubmitted("tok", identity("S1"), "The turn that failed", "p2", 300_000);
    log.noteEdit("tok", fakeDiff("/vault/half-written.md"), "p2", null);
    const promptId = store.openTurnId("tok");
    assert.equal(promptId, "p2", "the open turn is the one the failure ends");
    store.turnFailed("tok", "API Error: 500 Internal Server Error", identity("S1"), 360_000, promptId);
    await log.appendTurn("tok", promptId, []);

    await runTurn(log, store, "S1", "p3", "The retry", "/vault/c.md", 500_000);
    await log.endSession("tok");
    await settle();

    const note = vault.onlyNote();
    assert.deepEqual(vault.turnNumbers(), [1, 2, 3], "three turns, and no phantom fourth");

    const failed = note.data.slice(note.data.indexOf("## Turn 2"), note.data.indexOf("## Turn 3"));
    assert.ok(failed.includes("The turn that failed"), "the failed turn keeps its prompt");
    assert.ok(failed.includes("· failed"), "and is marked failed in its heading");
    assert.ok(failed.includes("API Error: 500 Internal Server Error"), "with the error it ended on");
    assert.ok(failed.includes("half-written.md"), "its edits are written under it");
    assert.ok(!note.data.includes("unfinished"), "and nothing is left to flush at the end");
  });

  it("has no open turn to offer once every turn has ended", async () => {
    const { store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "A finished turn", "/vault/a.md", 1000);
    assert.equal(store.openTurnId("tok"), undefined);
    assert.equal(store.openTurnId("no-such-terminal"), undefined);
  });
});

describe("session log: the goal", () => {
  it("names the session after its first prompt, not its latest", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "Could you please rewrite the pricing page?", "/vault/a.md", 1000);
    await runTurn(log, store, "S1", "p2", "Now do the changelog", "/vault/b.md", 200_000);
    await settle();

    const fm = vault.frontmatter.get(vault.onlyNote().path)!;
    // Same reduction a terminal group's name gets: the pleasantries and the
    // articles go, so the column reads as a title rather than a sentence.
    assert.equal(fm["terminus-goal"], "Rewrite pricing page", "the first prompt, titled");
  });

  it("writes no goal for a session that opened with a slash command", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "/compact", "/vault/a.md", 1000);
    await settle();

    assert.equal(vault.frontmatter.get(vault.onlyNote().path)!["terminus-goal"], undefined);
    assert.ok(!vault.onlyNote().data.includes("**Goal**"), "and no blank line in the note");
  });
});

describe("session log: the Bases view", () => {
  it("writes one into the folder, alongside the first note", async () => {
    const { vault, store, log } = setup();
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "First request", "/vault/a.md", 1000);
    await settle();

    const base = vault.base();
    assert.ok(base, "a base is written");
    assert.equal(base!.path, "Terminus/Sessions/Terminus sessions.base", "beside the notes");
    assert.equal(vault.notes().length, 1, "and it is not counted as a session note");
  });

  it("does not come back once deleted", async () => {
    const vault = makeVault();
    const first = setup(vault);
    start(first.log, first.store, "S1");
    await runTurn(first.log, first.store, "S1", "p1", "First request", "/vault/a.md", 1000);
    await settle();

    const path = vault.base()!.path;
    vault.files.delete(path);

    // A later session, carrying the settings the first one saved.
    const after = setup(vault);
    (after.log as unknown as { plugin: { settings: { multiAgent: Record<string, unknown> } } }).plugin.settings.multiAgent.sessionBaseCreated = true;
    start(after.log, after.store, "S2");
    await runTurn(after.log, after.store, "S2", "p2", "Second request", "/vault/b.md", 900_000);
    await settle();

    assert.equal(vault.base(), null, "deleting it is a decision that sticks");
    assert.equal(vault.notes().length, 2, "the notes are still written");
  });

  it("writes none on an Obsidian too old for Bases", async () => {
    const v = makeVault();
    const store = new AgentSessionStore();
    const log = new SessionLog(makePlugin(store, v.app, { supportsBases: false }));
    start(log, store, "S1");
    await runTurn(log, store, "S1", "p1", "First request", "/vault/a.md", 1000);
    await settle();

    assert.equal(v.base(), null, "no file the app cannot open");
    assert.equal(v.notes().length, 1, "the note is written regardless");
  });
});
