import type { AgentSession, SubagentRun, TurnRecord } from "./AgentSessionStore";
import type { PendingChange } from "./PendingChangesStore";

/** A subagent's row on a card, with the pending changes it made. */
export interface InboxSubagent {
  agentId: string;
  /** Null for a subagent the session no longer has on record (a new session
   *  started, or it fell past the store's cap) but whose changes are still
   *  pending; the row then shows the type taken from the change. */
  run: SubagentRun | null;
  agentType: string;
  changes: PendingChange[];
}

/** One user turn's slice of a card: the request, and what it changed. */
export interface InboxTurn {
  /** Null for the one group of changes whose payloads carried no prompt_id
   *  (hooks installed mid-turn, or a bridge from before they did). */
  promptId: string | null;
  /** The session's record of the turn, when it still has one: it can fall
   *  past the store's cap, or belong to the session that ran before a
   *  /clear while its changes are still pending. */
  record: TurnRecord | null;
  /** The prompt, when known; null for a turn seen only through its edits. */
  prompt: string | null;
  changes: PendingChange[];
  leadChanges: PendingChange[];
  /** Only the subagents that changed something in this turn: a subagent
   *  that made no changes belongs to the card, not to any one turn. */
  subagents: InboxSubagent[];
}

/** One card: a terminal's Claude session and the changes it left. */
export interface InboxCard {
  token: string;
  /** Null when changes are pending from a terminal with no session record. */
  session: AgentSession | null;
  /** Claude has exited or the terminal closed; the card stays only while
   *  its changes are pending. */
  ended: boolean;
  /** Every pending change on the card: the lead's and its subagents'. */
  changes: PendingChange[];
  leadChanges: PendingChange[];
  /** The subagent rows to show; see VISIBLE_FINISHED_SUBAGENTS. */
  subagents: InboxSubagent[];
  /** Finished subagents with no pending changes left out of `subagents`. */
  hiddenSubagents: number;
  /** The same changes grouped by the turn that made them, oldest turn
   *  first; see buildTurns. One entry means everything pending came from a
   *  single request, which is the common case and the one the card draws
   *  without turn headers. */
  turns: InboxTurn[];
}

export interface Inbox {
  needsAttention: InboxCard[];
  working: InboxCard[];
  /** Unread first, then read, then ended sessions that still have changes. */
  finished: InboxCard[];
}

/** Finished subagents with nothing pending still show, up to this many
 *  (the most recent); running, failed and ones with changes always do. */
export const VISIBLE_FINISHED_SUBAGENTS = 10;

/**
 * Sorts sessions and pending changes into the inbox's sections. A change
 * goes on the card of the terminal that edited it LAST, under the lead or
 * the subagent that made that edit, because the last edit is the one the
 * file on disk now holds and so the one the row's diff shows.
 *
 * Note this is not the terminal the row's revertText belongs to: rejecting
 * restores the state before the FIRST terminal's edit (see
 * PendingChangesStore.recordChange), which for a file two terminals touched
 * means reverting past a session whose card this is not. The card says so
 * rather than hiding it, and confirmCollisionReject asks before any such
 * reject regardless of the bulk-action setting. A session is listed while Claude runs in it,
 * or after it ended while it still has pending changes or queued feedback
 * (`feedbackTokens`), so that feedback can still be seen and discarded.
 */
export function buildInbox(sessions: AgentSession[], changes: PendingChange[], feedbackTokens: ReadonlySet<string> = new Set()): Inbox {
  const changesByToken = new Map<string, PendingChange[]>();
  for (const change of changes) {
    const owner = change.contributors[change.contributors.length - 1]?.token;
    if (!owner) continue;
    const list = changesByToken.get(owner) ?? [];
    list.push(change);
    changesByToken.set(owner, list);
  }

  const sessionTokens = new Set(sessions.map((s) => s.token));
  const cards: InboxCard[] = [];
  for (const session of sessions) {
    const cardChanges = changesByToken.get(session.token) ?? [];
    if (!session.running && cardChanges.length === 0 && !feedbackTokens.has(session.token)) continue;
    cards.push(buildCard(session.token, session, cardChanges));
  }
  for (const [token, cardChanges] of changesByToken) {
    if (!sessionTokens.has(token)) cards.push(buildCard(token, null, cardChanges));
  }
  for (const token of feedbackTokens) {
    if (!sessionTokens.has(token) && !changesByToken.has(token)) cards.push(buildCard(token, null, []));
  }

  const inbox: Inbox = { needsAttention: [], working: [], finished: [] };
  for (const card of cards) {
    if (!card.ended && card.session?.status === "needs-attention") inbox.needsAttention.push(card);
    else if (!card.ended && card.session?.status === "working") inbox.working.push(card);
    else inbox.finished.push(card);
  }
  // Stable sort: within a rank, cards keep session order.
  inbox.finished.sort((a, b) => finishedRank(a) - finishedRank(b));
  return inbox;
}

/**
 * Splits an inbox by the sidebar's selection. `inScope` is true for a card
 * the selected group (or Ungrouped, which shows in every group) owns, and for
 * a card with no terminal left, whose changes still need review. Everything
 * else goes to `elsewhere`, urgent first, so it can be listed compactly
 * instead of hidden.
 */
export function scopeInbox(inbox: Inbox, inScope: (card: InboxCard) => boolean): { scoped: Inbox; elsewhere: InboxCard[] } {
  const scoped: Inbox = { needsAttention: [], working: [], finished: [] };
  const elsewhere: InboxCard[] = [];
  const split = (cards: InboxCard[], into: InboxCard[]) => {
    for (const card of cards) (inScope(card) ? into : elsewhere).push(card);
  };
  split(inbox.needsAttention, scoped.needsAttention);
  split(inbox.working, scoped.working);
  split(inbox.finished, scoped.finished);
  return { scoped, elsewhere };
}

function finishedRank(card: InboxCard): number {
  if (card.ended) return 2;
  return card.session?.status === "finished-unread" ? 0 : 1;
}

function buildCard(token: string, session: AgentSession | null, changes: PendingChange[]): InboxCard {
  const runs = session?.subagents ?? [];
  const { leadChanges, byAgent } = splitByAgent(token, changes, runs);

  // Failed runs always show, like running ones: a failure shouldn't fold away.
  const finishedQuiet = runs.filter((r) => !r.running && r.outcome !== "failed" && !byAgent.has(r.agentId));
  const shownQuiet = new Set(finishedQuiet.slice(-VISIBLE_FINISHED_SUBAGENTS).map((r) => r.agentId));
  const subagents: InboxSubagent[] = [];
  for (const run of runs) {
    const withChanges = byAgent.get(run.agentId);
    if (withChanges) subagents.push(withChanges);
    else if (run.running || run.outcome === "failed" || shownQuiet.has(run.agentId)) {
      subagents.push({ agentId: run.agentId, run, agentType: run.agentType, changes: [] });
    }
  }
  // Changes from subagents the session no longer has on record go last.
  for (const row of byAgent.values()) if (!row.run) subagents.push(row);

  return {
    token,
    session,
    ended: !session || !session.running,
    changes,
    leadChanges,
    subagents,
    hiddenSubagents: finishedQuiet.length - shownQuiet.size,
    turns: buildTurns(token, session, changes),
  };
}

/**
 * Splits a set of a card's changes into the lead's and each subagent's.
 * Used for the whole card and again for each turn's slice of it, so both
 * attribute an edit the same way: by the agent that FIRST touched the file,
 * since that's the row's baseline (see PendingChangesStore.recordChange).
 */
function splitByAgent(
  token: string,
  changes: PendingChange[],
  runs: readonly SubagentRun[]
): { leadChanges: PendingChange[]; byAgent: Map<string, InboxSubagent> } {
  const leadChanges: PendingChange[] = [];
  const byAgent = new Map<string, InboxSubagent>();
  for (const change of changes) {
    const author = change.agents.find((a) => a.token === token);
    if (!author?.agentId) {
      leadChanges.push(change);
      continue;
    }
    let row = byAgent.get(author.agentId);
    if (!row) {
      const run = runs.find((r) => r.agentId === author.agentId) ?? null;
      row = { agentId: author.agentId, run, agentType: run?.agentType ?? author.agentType ?? "subagent", changes: [] };
      byAgent.set(author.agentId, row);
    }
    row.changes.push(change);
  }
  return { leadChanges, byAgent };
}

/**
 * The card's changes grouped by the turn that made them, in the session's
 * own turn order so they read oldest to newest like the conversation did.
 *
 * A row can coalesce edits from more than one turn (see
 * PendingChange.promptIds), and when two terminals edited it those ids span
 * both sessions. The row belongs to THIS session's turn, so the first id
 * this session has a record of wins; `promptIds[0]` is the fallback for a
 * turn no longer on record. A subagent's edits carry their lead's
 * prompt_id, so they land in the turn the user actually asked for rather
 * than in one of their own.
 */
function buildTurns(token: string, session: AgentSession | null, changes: PendingChange[]): InboxTurn[] {
  if (changes.length === 0) return [];
  const runs = session?.subagents ?? [];
  const byTurn = new Map<string, PendingChange[]>();
  const unattributed: PendingChange[] = [];
  const known = new Set((session?.turns ?? []).map((t) => t.promptId));
  for (const change of changes) {
    const promptId = change.promptIds.find((id) => known.has(id)) ?? change.promptIds[0];
    if (promptId === undefined) {
      unattributed.push(change);
      continue;
    }
    const list = byTurn.get(promptId) ?? [];
    list.push(change);
    byTurn.set(promptId, list);
  }

  const turns: InboxTurn[] = [];
  const add = (promptId: string | null, record: TurnRecord | null, inTurn: PendingChange[]) => {
    const { leadChanges, byAgent } = splitByAgent(token, inTurn, runs);
    const subagents: InboxSubagent[] = [];
    for (const run of runs) {
      const row = byAgent.get(run.agentId);
      if (row) subagents.push(row);
    }
    // Changes from subagents the session no longer has on record go last,
    // as they do on the card itself.
    for (const row of byAgent.values()) if (!row.run) subagents.push(row);
    turns.push({ promptId, record, prompt: record?.prompt ?? null, changes: inTurn, leadChanges, subagents });
  };

  for (const record of session?.turns ?? []) {
    const inTurn = byTurn.get(record.promptId);
    if (!inTurn) continue;
    byTurn.delete(record.promptId);
    add(record.promptId, record, inTurn);
  }
  // Any turn the session has no record of (past the store's cap, or from
  // before a /clear), in the order its changes were made.
  for (const [promptId, inTurn] of byTurn) add(promptId, null, inTurn);
  if (unattributed.length > 0) add(null, null, unattributed);
  return turns;
}
