import { ItemView, Menu, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { pathRelative } from "terminus-node-bridge";
import type { AgentSession, SubagentRun } from "../state/AgentSessionStore";
import { addUsage, totalTokens, UsageTotals } from "../claude/transcriptUsage";
import { PendingChange } from "../state/PendingChangesStore";
import { buildInbox, InboxCard, InboxSubagent } from "../state/inboxModel";
import { computeDiffStats } from "../diff/renderDiff";
import { ActionLogModal } from "../modals/ActionLogModal";
import { ChangeRowContext, renderChangeRow, renderHistorySection, runBulkAction } from "./changeRows";
import { guardRenderDuringPress } from "./renderGuard";
import { iconButton, iconLabel, makeActivatable } from "./uiHelpers";
import type TerminusPlugin from "../main";

export const AGENT_INBOX_VIEW_TYPE = "terminus-agent-inbox";

/**
 * The Multi-agent experience's review view, in place of Pending Changes: a
 * card per Claude session, sorted into Needs attention, Working and Finished, with
 * each session's pending changes inside its card under the lead or the
 * subagent that made them. Built from AgentSessionStore and
 * PendingChangesStore and re-rendered when either changes; nothing polls.
 */
export class AgentInboxView extends ItemView {
  /** Per-view UI state, kept across re-renders. */
  private collapsedCards = new Set<string>();
  private finishedCollapsed = false;
  /** Set in onOpen: holds renders while a mouse button is down here. */
  private guardedRender: () => void = () => this.renderNow();

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  private get rows(): ChangeRowContext {
    return { plugin: this.plugin, component: this, variant: "inbox" };
  }

  getViewType(): string {
    return AGENT_INBOX_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Agent inbox";
  }

  getIcon(): string {
    return "inbox";
  }

  async onOpen(): Promise<void> {
    this.plugin.dedupeView(AGENT_INBOX_VIEW_TYPE);
    this.guardedRender = guardRenderDuringPress(this, this.contentEl, () => this.renderNow());
    this.plugin.pendingChangesStore.on("change", this.render);
    this.plugin.agentSessionStore.on("change", this.render);
    this.plugin.feedbackStore.on("change", this.render);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
    this.plugin.agentSessionStore.off("change", this.render);
    this.plugin.feedbackStore.off("change", this.render);
  }

  /** Every re-render goes through here: the stores change often while
   *  Claude works, and a rebuild mid-click would lose the click (see
   *  renderGuard.ts). */
  render = (): void => this.guardedRender();

  private renderNow(): void {
    const container = this.contentEl;
    container.empty();
    // terminus-pending-view brings the Pending Changes row styles with it.
    container.addClass("terminus-pending-view", "terminus-inbox-view");

    const inbox = buildInbox(
      this.plugin.agentSessionStore.list(),
      this.plugin.pendingChangesStore.list(),
      this.plugin.feedbackStore.tokens()
    );
    const allChanges = this.plugin.pendingChangesStore.list();
    this.renderHeader(container, inbox.needsAttention.length, allChanges);
    this.renderTotals(container, [...inbox.needsAttention, ...inbox.working, ...inbox.finished]);

    const body = container.createDiv({ cls: "terminus-inbox-body" });
    const cardCount = inbox.needsAttention.length + inbox.working.length + inbox.finished.length;
    if (cardCount === 0) {
      const empty = body.createDiv({ cls: "terminus-inbox-empty" });
      setIcon(empty.createDiv({ cls: "terminus-inbox-empty-icon" }), "inbox");
      empty.createDiv({ cls: "terminus-inbox-empty-title", text: "No Claude sessions" });
      const text = empty.createDiv({ cls: "terminus-inbox-empty-text" });
      text.appendText("Type ");
      // A command name, not UI text, so it stays lowercase.
      const command = "claude";
      text.createEl("code", { text: command });
      text.appendText(" in a terminal. Each session gets a card here with what it's doing, what it changed, and when it needs you.");
    }

    this.renderSection(body, "Needs attention", inbox.needsAttention);
    this.renderSection(body, "Working", inbox.working);
    if (inbox.finished.length > 0) {
      const heading = this.renderSectionHeading(body, "Finished", inbox.finished.length, this.finishedCollapsed);
      const toggle = () => {
        this.finishedCollapsed = !this.finishedCollapsed;
        this.render();
      };
      heading.addEventListener("click", toggle);
      makeActivatable(heading, toggle, () => undefined);
      heading.setAttr("aria-expanded", String(!this.finishedCollapsed));
      if (!this.finishedCollapsed) for (const card of inbox.finished) this.renderCard(body, card);
    }

    const history = this.plugin.pendingChangesStore.listHistory();
    if (history.length > 0) renderHistorySection(this.rows, body, history);
  }

  private renderHeader(container: HTMLElement, needsCount: number, allChanges: PendingChange[]): void {
    const header = container.createDiv({ cls: "terminus-inbox-header" });
    header.createSpan({ cls: "terminus-inbox-title", text: "Agent inbox" });

    const next = header.createEl("button", { cls: "terminus-inbox-next" });
    setIcon(next.createSpan({ cls: "terminus-meta-icon" }), "skip-forward");
    next.createSpan({ text: "Next" });
    if (needsCount > 0) next.createSpan({ cls: "terminus-inbox-count", text: String(needsCount) });
    setTooltip(next, needsCount > 0 ? "Jump to the next session that needs attention" : "No session needs attention");
    next.disabled = needsCount === 0;
    next.addEventListener("click", () => void this.plugin.jumpToNextSessionNeedingAttention());

    iconButton(header, "more-horizontal", "More", (evt) => {
      const menu = new Menu();
      const resolveEverything = (accepted: boolean) =>
        void runBulkAction(this.rows, accepted, allChanges, () => this.plugin.pendingChangesStore.resolveAll(accepted));
      menu.addItem((item) =>
        item.setTitle("Keep all pending changes").setDisabled(allChanges.length === 0).onClick(() => resolveEverything(true))
      );
      menu.addItem((item) =>
        item.setTitle("Reject all pending changes").setDisabled(allChanges.length === 0).onClick(() => resolveEverything(false))
      );
      menu.addSeparator();
      menu.addItem((item) =>
        item.setTitle("Open action log").onClick(() => new ActionLogModal(this.app, this.plugin.actionLog).open())
      );
      menu.showAtMouseEvent(evt);
    });
  }

  /** One line under the header, for every card shown: how many sessions
   *  are running, tokens, and ≈ cost (unless hidden in settings). A line
   *  rather than stat tiles: the sidebar is narrow, and the cards are what
   *  matter. */
  private renderTotals(container: HTMLElement, cards: InboxCard[]): void {
    if (cards.length === 0) return;
    const usages = cards.map((card) => sessionUsage(card.session)).filter((u): u is UsageTotals => u !== null);
    const total = usages.reduce<UsageTotals | null>((sum, u) => (sum ? addUsage(sum, u) : u), null);
    const line = container.createDiv({ cls: "terminus-inbox-totals" });
    const live = cards.filter((card) => !card.ended).length;
    line.createSpan({ text: `${live} ${live === 1 ? "session" : "sessions"} running` });
    if (total) {
      const tokens = line.createSpan({ text: `${formatTokens(totalTokens(total))} tokens` });
      setTooltip(tokens, tokenBreakdown(total));
      if (this.plugin.settings.multiAgent.showEstimatedCost && total.costUsd !== null) {
        setTooltip(line.createSpan({ text: `≈ ${formatCost(total.costUsd)}` }), COST_TITLE);
      }
    }
  }

  private renderSection(body: HTMLElement, label: string, cards: InboxCard[]): void {
    if (cards.length === 0) return;
    this.renderSectionHeading(body, label, cards.length, null);
    for (const card of cards) this.renderCard(body, card);
  }

  /** `collapsed` null for a section that can't collapse. */
  private renderSectionHeading(body: HTMLElement, label: string, count: number, collapsed: boolean | null): HTMLElement {
    const heading = body.createDiv({ cls: "terminus-inbox-section" });
    if (collapsed !== null) {
      heading.addClass("is-collapsible");
      setIcon(heading.createSpan({ cls: "terminus-inbox-section-chevron" }), collapsed ? "chevron-right" : "chevron-down");
    }
    heading.createSpan({ text: label });
    heading.createSpan({ cls: "terminus-inbox-count", text: String(count) });
    return heading;
  }

  private renderCard(body: HTMLElement, card: InboxCard): void {
    const terminal = this.plugin.findTerminalView(card.token);
    const firstChange = card.changes[0];
    const name =
      terminal?.getDisplayText() ??
      firstChange?.panelLabel ??
      this.plugin.feedbackStore.listFor(card.token)[0]?.terminalLabel ??
      "Closed terminal";
    const color = terminal ? terminal.effectiveColor : (firstChange?.panelColor ?? null);
    const session = card.session;
    const needsAttention = !card.ended && session?.status === "needs-attention";
    const collapsed = this.collapsedCards.has(card.token);

    const el = body.createDiv({ cls: "terminus-inbox-card" });
    el.toggleClass("is-needs-attention", needsAttention);
    el.toggleClass("is-ended", card.ended);
    const head = el.createDiv({ cls: "terminus-inbox-card-head" });
    // The terminal's colour as a short stroke, like its tab and its row in
    // the sidebar; a group's colour is a dot.
    const swatch = head.createSpan({ cls: "terminus-inbox-card-stroke" });
    if (color) swatch.style.setProperty("--terminus-terminal-color", color);
    head.createSpan({ cls: "terminus-inbox-card-name", text: name });
    const pill = statusPill(card);
    head.createSpan({ cls: `terminus-inbox-pill is-${pill.kind}`, text: pill.label });
    setIcon(head.createSpan({ cls: "terminus-inbox-chevron" }), collapsed ? "chevron-right" : "chevron-down");
    const toggle = () => {
      if (collapsed) this.collapsedCards.delete(card.token);
      else this.collapsedCards.add(card.token);
      this.render();
    };
    head.addEventListener("click", toggle);
    makeActivatable(head, toggle, () => undefined);
    head.setAttr("aria-expanded", String(!collapsed));

    const meta = el.createDiv({ cls: "terminus-inbox-card-meta" });
    const group = this.plugin.groupStore.get(terminal?.groupId);
    if (group) {
      const groupLabel = meta.createSpan({ cls: "terminus-inbox-group" });
      groupLabel.createSpan({ cls: "terminus-group-dot" }).style.setProperty("--terminus-group-color", group.color);
      groupLabel.createSpan({ text: group.name });
      setTooltip(groupLabel, "This terminal's group");
    }
    if (session?.branch && this.plugin.settings.multiAgent.showGitBranch) {
      setTooltip(iconLabel(meta, "git-branch", session.branch, "terminus-inbox-branch"), "Git branch of this session's folder");
    }
    if (session?.lastTurnMs != null && session.status !== "working") {
      meta.createSpan({ text: `turn ${formatDuration(session.lastTurnMs)}` });
    }
    this.renderUsage(meta, sessionUsage(session), session?.usage ?? null);
    if (card.changes.length > 0) {
      const { added, removed } = sumStats(card.changes);
      // One unit, so a narrow card wraps before it rather than inside it.
      const pending = meta.createSpan({ cls: "terminus-inbox-pending" });
      pending.createSpan({ text: `${card.changes.length} pending` });
      pending.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
      pending.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
    }
    if (collapsed) return;

    if (needsAttention && session) {
      const banner = el.createDiv({ cls: "terminus-inbox-banner", attr: { role: "status" } });
      iconLabel(banner, "alert-triangle", session.needsMessage ?? needsFallback(session), "terminus-inbox-banner-text");
      if (terminal) {
        banner.createEl("button", { cls: "mod-cta", text: "Answer in terminal" }).addEventListener("click", () =>
          void this.plugin.focusTerminal(card.token)
        );
      }
    }
    // An unread turn's banner says Claude is waiting; its closing message is
    // what you'd want to read first, so it shows too.
    if (!needsAttention || session?.needs === "unread-turn") {
      const quote = this.quoteFor(card);
      if (quote) {
        const failed = session?.lastTurnFailed && session.status !== "working";
        const quoteEl = el.createDiv({ cls: `terminus-inbox-quote${failed ? " is-failed" : ""}`, attr: { title: quote } });
        if (failed) {
          setIcon(quoteEl.createSpan({ cls: "terminus-meta-icon" }), "x-circle");
          quoteEl.createSpan({ text: `Turn failed: ${quote}` });
        } else {
          quoteEl.setText(quote);
        }
      }
    }

    // The card's body: the work itself (changes, agents, queued comments),
    // below a rule and on the alternate surface, as a group card's
    // terminals are in the sidebar.
    const workEl = el.createDiv({ cls: "terminus-inbox-card-body" });
    if (card.leadChanges.length > 0 || card.subagents.length > 0) {
      if (card.subagents.length > 0) {
        // With subagents, the lead is one agent among them, in the same
        // shape of row, so the card reads as a list of agents, each with
        // its own changes underneath.
        this.renderAgent(workEl, {
          mark: { kind: "lead", icon: "bot", label: "Lead session" },
          name: "Lead",
          description: "Main session",
          details: [changeCount(card.leadChanges.length)],
          changes: card.leadChanges,
        });
      } else {
        this.renderChangeList(workEl.createDiv({ cls: "terminus-inbox-changes" }), card.leadChanges);
      }
      for (const sub of card.subagents) this.renderSubagent(workEl, sub);
      if (card.hiddenSubagents > 0) {
        workEl.createDiv({
          cls: "terminus-inbox-more",
          text: `${card.hiddenSubagents} earlier ${card.hiddenSubagents === 1 ? "subagent" : "subagents"} finished`,
        });
      }
    }

    this.renderFeedback(workEl, card.token, name);
    if (!workEl.hasChildNodes()) workEl.remove();

    const foot = el.createDiv({ cls: "terminus-inbox-card-foot" });
    if (card.changes.length > 0) {
      const ids = new Set(card.changes.map((c) => c.id));
      const inCard = (change: PendingChange) => ids.has(change.id);
      foot.createEl("button", { cls: "terminus-btn-ghost", text: "Reject all" }).addEventListener("click", () =>
        void runBulkAction(this.rows, false, card.changes, () => this.plugin.pendingChangesStore.resolveAll(false, inCard), name)
      );
      foot.createEl("button", { cls: "terminus-btn-ghost-accent", text: "Keep all" }).addEventListener("click", () =>
        void runBulkAction(this.rows, true, card.changes, () => this.plugin.pendingChangesStore.resolveAll(true, inCard), name)
      );
    } else {
      foot.createSpan({ cls: "terminus-inbox-foot-note", text: "No pending changes" });
    }
    foot.createDiv({ cls: "terminus-inbox-spacer" });
    if (terminal) {
      foot.createEl("button", { cls: "terminus-btn-ghost", text: "Open terminal" }).addEventListener("click", () =>
        void this.plugin.focusTerminal(card.token)
      );
    }
  }

  /** Queued review comments for this session, and the button that types
   *  them into its terminal -- only between turns (see feedbackReadiness). */
  private renderFeedback(el: HTMLElement, token: string, terminalName: string): void {
    const items = this.plugin.feedbackStore.listFor(token);
    if (items.length === 0) return;
    const section = el.createDiv({ cls: "terminus-inbox-feedback" });
    iconLabel(section, "message-square", `${items.length} ${items.length === 1 ? "comment" : "comments"} queued`, "terminus-inbox-feedback-title");
    const row = section.createDiv({ cls: "terminus-inbox-feedback-row" });
    const readiness = this.plugin.feedbackReadiness(token);
    if (readiness.ready) {
      const send = row.createEl("button", { cls: "mod-cta", text: `Send to ${terminalName}` });
      setTooltip(send, "Types the comments into the terminal's input line without sending them");
      send.addEventListener("click", () => void this.plugin.sendFeedback(token));
    } else {
      row.createSpan({ cls: "terminus-inbox-foot-note", text: readiness.reason });
    }
    row.createDiv({ cls: "terminus-inbox-spacer" });
    const discard = row.createEl("button", { text: "Discard" });
    setTooltip(discard, "Discard every queued comment for this session");
    discard.addEventListener("click", () => this.plugin.feedbackStore.clear(token));

    const list = section.createDiv({ cls: "terminus-inbox-feedback-list" });
    const base = this.plugin.getVaultBasePath();
    for (const item of items) {
      const line = list.createDiv({ cls: "terminus-inbox-feedback-item" });
      const where = item.newLines ?? item.oldLines;
      const place = `${pathRelative(base, item.filePath)}${where ? `:${where.start}` : ""}`;
      line.createSpan({ cls: "terminus-inbox-feedback-place", text: place });
      if (item.rejected) line.createSpan({ cls: "terminus-diff-stat-remove", text: "rejected" });
      line.createSpan({ cls: "terminus-inbox-feedback-text", text: item.comment, attr: { title: item.comment } });
      iconButton(line, "x", "Remove this comment", () => this.plugin.feedbackStore.remove(item.id));
    }
  }

  /** Tokens, context % and ≈ cost. `usage` is what's counted (a card's lead
   *  plus its subagents); `contextOf` is the one conversation whose context
   *  fill is shown. Nothing renders without usage, e.g. when Claude Code
   *  isn't saving transcripts. */
  private renderUsage(parent: HTMLElement, usage: UsageTotals | null, contextOf: UsageTotals | null): void {
    if (!usage) return;
    parent.createSpan({ text: `${formatTokens(totalTokens(usage))} tokens`, attr: { title: tokenBreakdown(usage) } });
    if (contextOf?.contextTokens != null && contextOf.contextWindow) {
      const percent = Math.round((contextOf.contextTokens / contextOf.contextWindow) * 100);
      parent.createSpan({
        text: `ctx ${percent}%`,
        attr: { title: `${formatTokens(contextOf.contextTokens)} of ${formatTokens(contextOf.contextWindow)} context used` },
      });
    }
    if (this.plugin.settings.multiAgent.showEstimatedCost && usage.costUsd !== null) {
      parent.createSpan({ text: `≈ ${formatCost(usage.costUsd)}`, attr: { title: COST_TITLE } });
    }
  }

  /** Two lines under the header: what Claude is doing, or what it said last. */
  private quoteFor(card: InboxCard): string | null {
    const session = card.session;
    if (!session) return null;
    if (!card.ended && session.status === "working") {
      if (!session.currentFile) return "Working…";
      return `Editing ${pathRelative(this.plugin.getVaultBasePath(), session.currentFile)}…`;
    }
    return session.lastMessage === null ? null : plainPreview(session.lastMessage);
  }

  private renderSubagent(el: HTMLElement, sub: InboxSubagent): void {
    const running = sub.run?.running ?? false;
    const details: string[] = [];
    const time = subagentTime(sub.run);
    if (time) details.push(time);
    const failed = sub.run?.outcome === "failed" && sub.run.error ? sub.run.error : null;
    this.renderAgent(el, {
      mark: subagentMark(sub.run),
      name: sub.agentType,
      description: sub.run?.description ?? null,
      details,
      usage: sub.run?.usage ?? null,
      changes: sub.changes,
      error: failed,
      title: !failed && sub.run?.lastMessage && !running ? sub.run.lastMessage : null,
    });
  }

  /** One agent on a card -- the lead or a subagent -- always in the same
   *  shape: a status mark, its name and task, a line of details, then its
   *  changes indented underneath. */
  private renderAgent(
    el: HTMLElement,
    agent: {
      mark: { kind: string; icon: string | null; label: string };
      name: string;
      description: string | null;
      details: string[];
      usage?: UsageTotals | null;
      changes: PendingChange[];
      error?: string | null;
      title?: string | null;
    }
  ): void {
    const row = el.createDiv({ cls: "terminus-inbox-agent" });
    const line = row.createDiv({ cls: "terminus-inbox-agent-line" });
    const markEl = line.createSpan({ cls: `terminus-inbox-agent-mark is-${agent.mark.kind}`, attr: { "aria-label": agent.mark.label } });
    // Running is a pulsing dot drawn in CSS; the rest are icons.
    if (agent.mark.icon) setIcon(markEl, agent.mark.icon);
    line.createSpan({ cls: "terminus-inbox-agent-name", text: agent.name });
    if (agent.description) line.createSpan({ cls: "terminus-inbox-agent-desc", text: agent.description, attr: { title: agent.description } });

    const details = row.createDiv({ cls: "terminus-inbox-agent-details" });
    for (const detail of agent.details) details.createSpan({ text: detail });
    if (agent.usage) this.renderUsage(details, agent.usage, agent.usage);
    if (agent.mark.kind !== "lead") details.createSpan({ text: changeCount(agent.changes.length) });
    if (agent.error) {
      // First line only; the full error is on hover.
      row.createDiv({ cls: "terminus-inbox-agent-error", text: agent.error.split("\n")[0] ?? "", attr: { title: agent.error } });
    } else if (agent.title) {
      row.setAttr("title", agent.title);
    }

    if (agent.changes.length > 0) this.renderChangeList(row.createDiv({ cls: "terminus-inbox-agent-changes" }), agent.changes);
  }

  private renderChangeList(parent: HTMLElement, changes: PendingChange[]): void {
    if (changes.length === 0) return;
    const list = parent.createDiv({ cls: "terminus-pending-list" });
    for (const change of changes) renderChangeRow(this.rows, list, change, computeDiffStats(change.diff));
  }
}

const COST_TITLE =
  "Estimated from Terminus's built-in API price table, not a bill. On a Claude subscription, usage counts against your plan instead.";

/** A session's usage: its lead plus every subagent. Null with no usage. */
function sessionUsage(session: AgentSession | null): UsageTotals | null {
  if (!session) return null;
  let total = session.usage;
  for (const run of session.subagents) {
    if (run.usage) total = total ? addUsage(total, run.usage) : run.usage;
  }
  return total;
}

function tokenBreakdown(usage: UsageTotals): string {
  return [
    `Input: ${formatTokens(usage.inputTokens)}`,
    `Output: ${formatTokens(usage.outputTokens)}`,
    `Cache reads: ${formatTokens(usage.cacheReadTokens)}`,
    `Cache writes: ${formatTokens(usage.cacheWriteTokens)}`,
  ].join("\n");
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

function statusPill(card: InboxCard): { kind: string; label: string } {
  const session = card.session;
  if (card.ended || !session) return { kind: "ended", label: "Session ended" };
  switch (session.status) {
    case "needs-attention":
      return { kind: "needs-attention", label: session.needs === "permission" ? "Needs permission" : session.needs === "input" || session.needs === "unread-turn" ? "Waiting for you" : "Needs attention" };
    case "working":
      return { kind: "working", label: "Working" };
    case "finished-unread":
      return { kind: "finished", label: "Finished" };
    case "idle":
      return { kind: "idle", label: "Idle" };
  }
}

/** Claude's messages are Markdown; the two-line preview shows them as
 *  plain text rather than with their `**` and backticks. */
function plainPreview(markdown: string): string {
  let text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, "");
  // Repeated for nesting (**`file`**). Underscores are left alone: they're
  // far more often part of a name than emphasis in Claude's messages.
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/(\*\*|\*|`)(\S(?:[^]*?\S)?)\1/g, "$2");
  }
  return text.replace(/\s+/g, " ").trim();
}

function needsFallback(session: AgentSession): string {
  if (session.needs === "permission") return "Claude needs your permission.";
  if (session.needs === "input" || session.needs === "unread-turn") return "Claude is waiting for your input.";
  return "Claude needs your attention.";
}

/** A pulsing dot while running, then a check (done), an x (failed, red) or
 *  a square (stopped, grey: stopping isn't failing). The label says it in
 *  words too, for screen readers and for anyone who can't tell the colours
 *  apart. */
function subagentMark(run: SubagentRun | null): { kind: string; icon: string | null; label: string } {
  if (!run) return { kind: "done", icon: "check", label: "Finished" };
  if (run.running) return { kind: "running", icon: null, label: "Running" };
  switch (run.outcome) {
    case "failed":
      return { kind: "failed", icon: "x", label: "Failed" };
    case "stopped":
      return { kind: "stopped", icon: "square", label: "Stopped" };
    default:
      return { kind: "done", icon: "check", label: "Finished" };
  }
}

function subagentTime(run: SubagentRun | null): string | null {
  if (!run) return null;
  if (run.running) return `started ${formatClock(run.startedAt)}`;
  if (run.endedAt === null) return null;
  const duration = formatDuration(run.endedAt - run.startedAt);
  if (run.outcome === "failed") return `Failed after ${duration}`;
  if (run.outcome === "stopped") return `Stopped after ${duration}`;
  return duration;
}

function changeCount(n: number): string {
  if (n === 0) return "no changes";
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

function sumStats(changes: PendingChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const stats = computeDiffStats(change.diff);
    added += stats.added;
    removed += stats.removed;
  }
  return { added, removed };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
