import { ItemView, Menu, WorkspaceLeaf } from "obsidian";
import { pathRelative } from "terminus-node-bridge";
import type { AgentSession, SubagentRun } from "../state/AgentSessionStore";
import { PendingChange } from "../state/PendingChangesStore";
import { buildInbox, InboxCard, InboxSubagent } from "../state/inboxModel";
import { computeDiffStats } from "../diff/renderDiff";
import { ActionLogModal } from "../modals/ActionLogModal";
import { ChangeRowContext, renderChangeRow, renderHistorySection, runBulkAction } from "./changeRows";
import type TerminusPlugin from "../main";

export const AGENT_INBOX_VIEW_TYPE = "terminus-agent-inbox";

/**
 * The Multi-agent experience's review view, in place of Pending Changes: a
 * card per Claude session, sorted into Needs you, Working and Finished, with
 * each session's pending changes inside its card under the lead or the
 * subagent that made them. Built from AgentSessionStore and
 * PendingChangesStore and re-rendered when either changes; nothing polls.
 */
export class AgentInboxView extends ItemView {
  /** Per-view UI state, kept across re-renders. */
  private collapsedCards = new Set<string>();
  private finishedCollapsed = false;

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  private get rows(): ChangeRowContext {
    return { plugin: this.plugin, component: this };
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
    this.plugin.pendingChangesStore.on("change", this.render);
    this.plugin.agentSessionStore.on("change", this.render);
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
    this.plugin.agentSessionStore.off("change", this.render);
  }

  render = (): void => {
    const container = this.contentEl;
    container.empty();
    // terminus-pending-view brings the Pending Changes row styles with it.
    container.addClass("terminus-pending-view", "terminus-inbox-view");

    const inbox = buildInbox(this.plugin.agentSessionStore.list(), this.plugin.pendingChangesStore.list());
    const allChanges = this.plugin.pendingChangesStore.list();
    this.renderHeader(container, inbox.needsYou.length, allChanges);

    const body = container.createDiv({ cls: "terminus-inbox-body" });
    const cardCount = inbox.needsYou.length + inbox.working.length + inbox.finished.length;
    if (cardCount === 0) {
      const empty = body.createDiv({ cls: "terminus-pending-empty terminus-inbox-empty" });
      empty.appendText("No Claude sessions. Type ");
      // A command name, not UI text, so it stays lowercase.
      const command = "claude";
      empty.createEl("code", { text: command });
      empty.appendText(" in a terminal to start one.");
    }

    this.renderSection(body, "Needs you", inbox.needsYou);
    this.renderSection(body, "Working", inbox.working);
    if (inbox.finished.length > 0) {
      const heading = this.renderSectionHeading(body, "Finished", inbox.finished.length, this.finishedCollapsed);
      heading.addEventListener("click", () => {
        this.finishedCollapsed = !this.finishedCollapsed;
        this.render();
      });
      if (!this.finishedCollapsed) for (const card of inbox.finished) this.renderCard(body, card);
    }

    const history = this.plugin.pendingChangesStore.listHistory();
    if (history.length > 0) renderHistorySection(this.rows, body, history);
  };

  private renderHeader(container: HTMLElement, needsCount: number, allChanges: PendingChange[]): void {
    const header = container.createDiv({ cls: "terminus-inbox-header" });
    header.createSpan({ cls: "terminus-inbox-title", text: "Agent inbox" });

    const next = header.createEl("button", {
      cls: "terminus-btn-outline",
      text: needsCount > 0 ? `Next ⇥ (${needsCount})` : "Next ⇥",
      attr: { "aria-label": "Jump to the next session that needs you" },
    });
    next.disabled = needsCount === 0;
    next.addEventListener("click", () => void this.plugin.jumpToNextSessionNeedingYou());

    const more = header.createEl("button", { cls: "terminus-btn-outline", text: "⋯", attr: { "aria-label": "More" } });
    more.addEventListener("click", (evt) => {
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
      heading.createSpan({ cls: "terminus-inbox-section-chevron", text: collapsed ? "▸" : "▾" });
    }
    heading.createSpan({ text: `${label} · ${count}` });
    return heading;
  }

  private renderCard(body: HTMLElement, card: InboxCard): void {
    const terminal = this.plugin.findTerminalView(card.token);
    const firstChange = card.changes[0];
    const name = terminal?.getDisplayText() ?? firstChange?.panelLabel ?? "Closed terminal";
    const color = terminal ? terminal.colorTag : (firstChange?.panelColor ?? null);
    const session = card.session;
    const needsYou = !card.ended && session?.status === "needs-you";
    const collapsed = this.collapsedCards.has(card.token);

    const el = body.createDiv({ cls: "terminus-inbox-card" });
    el.toggleClass("is-needs-you", needsYou);
    el.toggleClass("is-ended", card.ended);
    if (color) {
      el.addClass("terminus-group-colored");
      el.style.setProperty("--terminus-group-color", color);
    }

    const head = el.createDiv({ cls: "terminus-inbox-card-head" });
    head.createSpan({ cls: "terminus-inbox-card-name", text: name });
    const pill = statusPill(card);
    head.createSpan({ cls: `terminus-inbox-pill is-${pill.kind}`, text: pill.label });
    head.createSpan({ cls: "terminus-inbox-chevron", text: collapsed ? "▸" : "▾" });
    head.addEventListener("click", () => {
      if (collapsed) this.collapsedCards.delete(card.token);
      else this.collapsedCards.add(card.token);
      this.render();
    });

    const meta = el.createDiv({ cls: "terminus-inbox-card-meta" });
    if (session?.branch && this.plugin.settings.multiAgent.showGitBranch) {
      meta.createSpan({ cls: "terminus-inbox-branch", text: `⎇ ${session.branch}`, attr: { title: "Git branch of this session's folder" } });
    }
    if (session?.lastTurnMs != null && session.status !== "working") {
      meta.createSpan({ text: `turn ${formatDuration(session.lastTurnMs)}` });
    }
    if (card.changes.length > 0) {
      const { added, removed } = sumStats(card.changes);
      meta.createSpan({ text: `${card.changes.length} pending` });
      meta.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
      meta.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
    }
    if (collapsed) return;

    if (needsYou && session) {
      const banner = el.createDiv({ cls: "terminus-inbox-banner" });
      banner.createSpan({ text: `⚠ ${session.needsMessage ?? needsFallback(session)}` });
      if (terminal) {
        banner.createEl("button", { cls: "terminus-btn-solid", text: "Answer in terminal" }).addEventListener("click", () =>
          void this.plugin.focusTerminal(card.token)
        );
      }
    } else {
      const quote = this.quoteFor(card);
      if (quote) el.createDiv({ cls: "terminus-inbox-quote", text: quote, attr: { title: quote } });
    }

    if (card.leadChanges.length > 0 || card.subagents.length > 0) {
      if (card.subagents.length > 0) {
        const who = el.createDiv({ cls: "terminus-inbox-who" });
        who.createSpan({ cls: "terminus-inbox-who-label", text: "Lead" });
        who.createSpan({ text: changeCount(card.leadChanges.length) });
      }
      this.renderChangeList(el, card.leadChanges);
      for (const sub of card.subagents) this.renderSubagent(el, sub);
      if (card.hiddenSubagents > 0) {
        el.createDiv({
          cls: "terminus-inbox-more",
          text: `${card.hiddenSubagents} earlier ${card.hiddenSubagents === 1 ? "subagent" : "subagents"} finished`,
        });
      }
    }

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
    const row = el.createDiv({ cls: "terminus-inbox-subagent" });
    const line = row.createDiv({ cls: "terminus-inbox-subagent-line" });
    const running = sub.run?.running ?? false;
    line.createSpan({
      cls: `terminus-inbox-subagent-mark ${running ? "is-running" : "is-done"}`,
      text: running ? "●" : "✓",
      attr: { "aria-label": running ? "Running" : "Finished" },
    });
    line.createSpan({ cls: "terminus-inbox-subagent-type", text: sub.agentType });
    const description = sub.run?.description;
    if (description) line.createSpan({ cls: "terminus-inbox-subagent-desc", text: description, attr: { title: description } });

    const details = row.createDiv({ cls: "terminus-inbox-subagent-details" });
    const time = subagentTime(sub.run);
    if (time) details.createSpan({ text: time });
    details.createSpan({ text: changeCount(sub.changes.length) });
    if (sub.run?.lastMessage && !running) {
      row.setAttr("title", sub.run.lastMessage);
    }

    if (sub.changes.length > 0) {
      const nested = el.createDiv({ cls: "terminus-inbox-subagent-changes" });
      this.renderChangeList(nested, sub.changes);
    }
  }

  private renderChangeList(parent: HTMLElement, changes: PendingChange[]): void {
    if (changes.length === 0) return;
    const list = parent.createDiv({ cls: "terminus-pending-list" });
    for (const change of changes) renderChangeRow(this.rows, list, change, computeDiffStats(change.diff));
  }
}

function statusPill(card: InboxCard): { kind: string; label: string } {
  const session = card.session;
  if (card.ended || !session) return { kind: "ended", label: "Session ended" };
  switch (session.status) {
    case "needs-you":
      return { kind: "needs-you", label: session.needs === "permission" ? "Needs permission" : session.needs === "input" ? "Waiting for you" : "Needs you" };
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
  if (session.needs === "input") return "Claude is waiting for your input.";
  return "Claude needs you.";
}

function subagentTime(run: SubagentRun | null): string | null {
  if (!run) return null;
  if (run.running) return `started ${formatClock(run.startedAt)}`;
  return run.endedAt === null ? null : formatDuration(run.endedAt - run.startedAt);
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
