import { describe, it } from "node:test";
import assert from "node:assert";
import { AgentSessionStore, activeTime } from "../src/state/AgentSessionStore";
import { buildInbox } from "../src/state/inboxModel";
import type { PendingChange } from "../src/state/PendingChangesStore";
import { identity } from "./helpers/fakeVault";

/**
 * Turn records and how the Agent inbox groups a card's pending changes by
 * the request that caused them. The rules worth pinning down are the two
 * that are easy to get backwards: a row touched by several turns belongs to
 * the FIRST of them (the snapshot a reject returns it to), and a subagent's
 * edits belong to the lead's turn, not one of their own.
 */

function change(path: string, promptIds: string[], agentId: string | null = null): PendingChange {
  return {
    id: path,
    payload: { tool_name: "Edit" },
    diff: { filePath: path, oldText: "a\n", newText: "b\n", revertText: "a\n", existedBefore: true },
    panelLabel: "T1",
    panelColor: null,
    createdAt: Date.now(),
    editCount: 1,
    contributors: [{ token: "tok", label: "T1", color: null }],
    agents: [{ token: "tok", agentId, agentType: agentId ? "general-purpose" : null }],
    promptIds,
    brokenBacklinks: [],
  } as unknown as PendingChange;
}

describe("turn records", () => {
  it("keeps one record per user turn, however many edits it makes", () => {
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.promptSubmitted("tok", identity("S1"), "Group changes by prompt", "p1", 1000);
    store.fileEdited("tok", "/repo/a.ts", identity("S1"), "p1");
    store.fileEdited("tok", "/repo/b.ts", identity("S1"), "p1");
    store.turnEnded("tok", "done", identity("S1"), 4000, false, "p1");

    const session = store.get("tok")!;
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0]!.prompt, "Group changes by prompt", "prompt text joined by prompt_id");
    assert.equal(session.turns[0]!.endedAt, 4000);
  });

  it("counts active time, not wall clock, and exposes a running turn", () => {
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.promptSubmitted("tok", identity("S1"), "One", "p1", 1000);
    store.turnEnded("tok", "done", identity("S1"), 4000, false, "p1");
    store.promptSubmitted("tok", identity("S1"), "Two", "p2", 10_000);

    const { finishedMs, runningSince } = activeTime(store.get("tok")!);
    assert.equal(finishedMs, 3000, "finished turns add up");
    assert.equal(runningSince, 10_000, "the open turn is reported separately, not counted");
  });

  it("closes the open turn on a failure that carries no prompt_id", () => {
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.promptSubmitted("tok", identity("S1"), "One", "p1", 1000);
    store.turnFailed("tok", "model_not_found", identity("S1"), 5000, undefined);

    const session = store.get("tok")!;
    assert.equal(session.turns[0]!.failed, true);
    assert.equal(activeTime(session).runningSince, null, "nothing is left ticking");
  });

  it("records a turn first seen through one of its edits", () => {
    // Classic installs no UserPromptSubmit hook, so an edit names the turn.
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.fileEdited("tok", "/repo/c.ts", identity("S1"), "p3");
    const session = store.get("tok")!;
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0]!.prompt, null, "no prompt text without the hook");
  });

  it("starts from a clean slate on /clear", () => {
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.promptSubmitted("tok", identity("S1"), "One", "p1", 1000);
    store.sessionStarted("tok", identity("S2"));
    assert.equal(store.get("tok")!.turns.length, 0);
  });
});

describe("inbox: grouping changes by turn", () => {
  function cardWithTurns() {
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.promptSubmitted("tok", identity("S1"), "First request", "p1", 1000);
    store.turnEnded("tok", "ok", identity("S1"), 2000, false, "p1");
    store.promptSubmitted("tok", identity("S1"), "Second request", "p2", 3000);
    store.subagentStarted("tok", "a1", "general-purpose", identity("S1"), 3100);
    store.turnEnded("tok", "ok", identity("S1"), 5000, false, "p2");

    const changes = [
      change("/repo/a.ts", ["p1"]),
      change("/repo/b.ts", ["p1"]),
      change("/repo/c.ts", ["p2"]),
      change("/repo/sub.ts", ["p2"], "a1"),
      change("/repo/spanning.ts", ["p1", "p2"]),
      change("/repo/unknown.ts", []),
    ];
    const inbox = buildInbox(store.list(), changes);
    const card = inbox.finished[0] ?? inbox.working[0] ?? inbox.needsAttention[0];
    assert.ok(card, "a card was built");
    return { card, changes };
  }

  it("lists a row touched by two turns under the first of them", () => {
    const { card } = cardWithTurns();
    const first = card.turns[0]!;
    assert.equal(first.prompt, "First request");
    assert.deepEqual(
      first.changes.map((c) => c.id).sort(),
      ["/repo/a.ts", "/repo/b.ts", "/repo/spanning.ts"],
      "the spanning row belongs to its baseline turn"
    );
  });

  it("puts a subagent's edits in the lead's turn, under their own row", () => {
    const { card } = cardWithTurns();
    const second = card.turns[1]!;
    assert.equal(second.prompt, "Second request");
    assert.deepEqual(second.leadChanges.map((c) => c.id), ["/repo/c.ts"]);
    assert.equal(second.subagents.length, 1);
    assert.deepEqual(second.subagents[0]!.changes.map((c) => c.id), ["/repo/sub.ts"]);
  });

  it("collects changes with no prompt_id into one last group", () => {
    const { card } = cardWithTurns();
    const last = card.turns[card.turns.length - 1]!;
    assert.equal(last.promptId, null);
    assert.deepEqual(last.changes.map((c) => c.id), ["/repo/unknown.ts"]);
  });

  it("leaves the card's flat list and agent split intact", () => {
    const { card } = cardWithTurns();
    assert.equal(card.changes.length, 6);
    const viaAgents = card.leadChanges.length + card.subagents.reduce((n, s) => n + s.changes.length, 0);
    assert.equal(viaAgents, 6, "every change is still accounted for the old way too");
  });

  it("reports a single turn when everything came from one request", () => {
    const store = new AgentSessionStore();
    store.sessionStarted("tok", identity("S1"));
    store.promptSubmitted("tok", identity("S1"), "Only request", "p1", 1000);
    store.turnEnded("tok", "ok", identity("S1"), 2000, false, "p1");
    const inbox = buildInbox(store.list(), [change("/repo/a.ts", ["p1"])]);
    const card = inbox.finished[0]!;
    assert.equal(card.turns.length, 1, "the card then draws no turn headers");
  });
});
