import type { AgentSession, SubagentRun } from "./AgentSessionStore";
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
}

export interface Inbox {
  needsYou: InboxCard[];
  working: InboxCard[];
  /** Unread first, then read, then ended sessions that still have changes. */
  finished: InboxCard[];
}

/** Finished subagents with nothing pending still show, up to this many
 *  (the most recent); running ones and ones with changes always do. */
export const VISIBLE_FINISHED_SUBAGENTS = 3;

/**
 * Sorts sessions and pending changes into the inbox's sections. A change
 * goes on the card of the terminal that first edited it (the same terminal
 * its row has always been labelled with), under the lead or the subagent
 * that made that first edit. A session is listed while Claude runs in it,
 * or after it ended while it still has pending changes.
 */
export function buildInbox(sessions: AgentSession[], changes: PendingChange[]): Inbox {
  const changesByToken = new Map<string, PendingChange[]>();
  for (const change of changes) {
    const owner = change.contributors[0]?.token;
    if (!owner) continue;
    const list = changesByToken.get(owner) ?? [];
    list.push(change);
    changesByToken.set(owner, list);
  }

  const sessionTokens = new Set(sessions.map((s) => s.token));
  const cards: InboxCard[] = [];
  for (const session of sessions) {
    const cardChanges = changesByToken.get(session.token) ?? [];
    if (!session.running && cardChanges.length === 0) continue;
    cards.push(buildCard(session.token, session, cardChanges));
  }
  for (const [token, cardChanges] of changesByToken) {
    if (!sessionTokens.has(token)) cards.push(buildCard(token, null, cardChanges));
  }

  const inbox: Inbox = { needsYou: [], working: [], finished: [] };
  for (const card of cards) {
    if (!card.ended && card.session?.status === "needs-you") inbox.needsYou.push(card);
    else if (!card.ended && card.session?.status === "working") inbox.working.push(card);
    else inbox.finished.push(card);
  }
  // Stable sort: within a rank, cards keep session order.
  inbox.finished.sort((a, b) => finishedRank(a) - finishedRank(b));
  return inbox;
}

function finishedRank(card: InboxCard): number {
  if (card.ended) return 2;
  return card.session?.status === "finished-unread" ? 0 : 1;
}

function buildCard(token: string, session: AgentSession | null, changes: PendingChange[]): InboxCard {
  const leadChanges: PendingChange[] = [];
  const byAgent = new Map<string, InboxSubagent>();
  const runs = session?.subagents ?? [];

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

  const finishedQuiet = runs.filter((r) => !r.running && !byAgent.has(r.agentId));
  const shownQuiet = new Set(finishedQuiet.slice(-VISIBLE_FINISHED_SUBAGENTS).map((r) => r.agentId));
  const subagents: InboxSubagent[] = [];
  for (const run of runs) {
    const withChanges = byAgent.get(run.agentId);
    if (withChanges) subagents.push(withChanges);
    else if (run.running || shownQuiet.has(run.agentId)) {
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
  };
}
