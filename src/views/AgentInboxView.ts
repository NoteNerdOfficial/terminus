import { ItemView, Menu, Platform, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { pathRelative } from "terminus-node-bridge";
import type { AgentSession, SubagentRun } from "../state/AgentSessionStore";
import { addUsage, totalTokens, UsageTotals } from "../claude/transcriptUsage";
import { PendingChange } from "../state/PendingChangesStore";
import { buildInbox, InboxCard, InboxSubagent, scopeInbox } from "../state/inboxModel";
import type { InboxUiState } from "../state/InboxUiState";
import { TerminalView } from "./TerminalView";
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
  /** The terminal in front, whose card is marked; only that changes on a focus event. */
  private focusedToken: string | null = null;
  /** A render was asked for while a guidance box had focus (see renderNow). */
  private renderSkipped = false;
  /** Set in onOpen: holds renders while a mouse button is down here. */
  private guardedRender: () => void = () => this.renderNow();

  constructor(leaf: WorkspaceLeaf, private plugin: TerminusPlugin) {
    super(leaf);
  }

  private get ui(): InboxUiState {
    return this.plugin.inboxUi;
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
    // The selected group scopes what's shown; its change event also covers
    // groups being renamed, recoloured or closed.
    this.plugin.groupStore.on("change", this.render);
    this.plugin.delegationStore.on("change", this.render);
    const front = this.app.workspace.getMostRecentLeaf()?.view;
    this.focusedToken = front instanceof TerminalView ? front.hookToken : null;
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onFocusChange()));
    // Running timers advance in place: a re-render every second would
    // fight clicks (see renderGuard.ts) for the sake of a number.
    this.registerInterval(window.setInterval(() => this.tickElapsed(), 1000));
    this.render();
  }

  /** Brings the card the sidebar pointed at into view, unfolded, and marks
   *  it for a moment. */
  private revealRequested(container: HTMLElement): void {
    const token = this.ui.revealToken;
    if (!token) return;
    this.ui.revealToken = null;
    const card = container.querySelector<HTMLElement>(`.terminus-inbox-card[data-token="${CSS.escape(token)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "nearest" });
    card.addClass("is-revealed");
    window.setTimeout(() => card.removeClass("is-revealed"), 1500);
  }

  private tickElapsed(): void {
    this.contentEl.querySelectorAll<HTMLElement>(".terminus-inbox-live-elapsed").forEach((el) => {
      el.setText(formatDuration(Date.now() - Number(el.dataset.since)));
    });
  }

  /** Only the terminal in front matters here (clicking into this pane makes
   *  no terminal active), and only a different one needs a render. */
  private onFocusChange(): void {
    const front = this.app.workspace.getMostRecentLeaf()?.view;
    const token = front instanceof TerminalView ? front.hookToken : null;
    if (token === this.focusedToken) return;
    this.focusedToken = token;
    this.render();
  }

  async onClose(): Promise<void> {
    this.plugin.pendingChangesStore.off("change", this.render);
    this.plugin.agentSessionStore.off("change", this.render);
    this.plugin.feedbackStore.off("change", this.render);
    this.plugin.groupStore.off("change", this.render);
    this.plugin.delegationStore.off("change", this.render);
    // The user closing the inbox is a choice an auto-reveal must respect;
    // Obsidian closing it on unload or a mode switch is not.
    if (!this.plugin.isUnloading) this.ui.userAction();
  }

  /** Every re-render goes through here: the stores change often while
   *  Claude works, and a rebuild mid-click would lose the click (see
   *  renderGuard.ts). */
  render = (): void => this.guardedRender();

  private renderNow(): void {
    const container = this.contentEl;
    // Rebuilding the view under a box someone is typing in would take its
    // focus and caret; the render waits until the box loses focus.
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.hasClass("terminus-inbox-steer-input") && container.contains(active)) {
      this.renderSkipped = true;
      return;
    }
    // Emptying the view resets its scroll; the stores re-render it often
    // while Claude works, so put the user back where they were.
    const scrollTop = container.scrollTop;
    container.empty();
    // terminus-pending-view brings the Pending Changes row styles with it.
    container.addClass("terminus-pending-view", "terminus-inbox-view");

    const full = buildInbox(
      this.plugin.agentSessionStore.list(),
      this.plugin.pendingChangesStore.list(),
      this.plugin.feedbackStore.tokens()
    );
    const allChanges = this.plugin.pendingChangesStore.list();
    // A dismissed card stays away until its session starts another turn
    // (it leaves Finished), or gets something to review again.
    for (const card of [...full.needsAttention, ...full.working]) this.ui.dismissed.delete(card.token);

    // The sidebar's selected group decides what gets full cards; the rest
    // is listed compactly under Elsewhere so nothing urgent is hidden.
    const scope = this.selection();
    const split = this.ui.showAll ? { scoped: full, elsewhere: [] } : scopeInbox(full, scope.inScope);
    const inbox = split.scoped;
    // A snoozed group's sessions stay out of sight until it wakes (Show all
    // still lists them).
    const snoozed = (card: InboxCard) => {
      const group = this.plugin.groupStore.get(this.plugin.findTerminalView(card.token)?.groupId);
      return group !== undefined && group.snoozedUntil !== null;
    };
    const elsewhere = split.elsewhere.filter((card) => !snoozed(card) && !(this.ui.dismissed.has(card.token) && this.dismissible(card)));
    this.renderHeader(container, full.needsAttention.length, allChanges);
    this.renderScope(container, scope, elsewhere);
    this.renderTotals(container, [...inbox.needsAttention, ...inbox.working, ...inbox.finished]);

    const body = container.createDiv({ cls: "terminus-inbox-body" });
    const cardCount = inbox.needsAttention.length + inbox.working.length + inbox.finished.length;
    if (cardCount === 0 && elsewhere.length === 0) {
      const empty = body.createDiv({ cls: "terminus-inbox-empty" });
      setIcon(empty.createDiv({ cls: "terminus-inbox-empty-icon" }), "inbox");
      empty.createDiv({ cls: "terminus-inbox-empty-title", text: "No Claude sessions" });
      const text = empty.createDiv({ cls: "terminus-inbox-empty-text" });
      text.appendText("Type ");
      // A command name, not UI text, so it stays lowercase.
      const command = "claude";
      text.createEl("code", { text: command });
      text.appendText(" in a terminal. Each session gets a card here with what it's doing, what it changed, and when it needs you.");
    } else if (cardCount === 0) {
      const empty = body.createDiv({ cls: "terminus-inbox-empty" });
      setIcon(empty.createDiv({ cls: "terminus-inbox-empty-icon" }), "inbox");
      empty.createDiv({ cls: "terminus-inbox-empty-title", text: `Nothing in ${scope.label}` });
      empty.createDiv({ cls: "terminus-inbox-empty-text", text: "Sessions in your other groups are listed below." });
    }

    this.renderSection(body, "Needs attention", inbox.needsAttention);
    this.renderSection(body, "Working", inbox.working);
    const finished = inbox.finished.filter((card) => !(this.ui.dismissed.has(card.token) && this.dismissible(card)));
    if (finished.length > 0) {
      const heading = this.renderSectionHeading(body, "Finished", finished.length, this.ui.finishedCollapsed);
      const toggle = () => {
        this.ui.userAction();
        this.ui.finishedCollapsed = !this.ui.finishedCollapsed;
        this.render();
      };
      heading.addEventListener("click", toggle);
      makeActivatable(heading, toggle, () => undefined);
      heading.setAttr("aria-expanded", String(!this.ui.finishedCollapsed));
      const clearable = finished.filter((card) => this.dismissible(card));
      if (clearable.length > 0) {
        const clear = heading.createEl("button", { cls: "terminus-inbox-clear", text: "Clear" });
        setTooltip(clear, "Dismiss finished sessions with nothing left to review");
        clear.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.dismiss(clearable);
        });
        clear.addEventListener("keydown", (evt) => evt.stopPropagation());
      }
      if (!this.ui.finishedCollapsed) for (const card of finished) this.renderCard(body, card, true);
    } else if (cardCount > 0 && inbox.needsAttention.length === 0 && inbox.working.length === 0) {
      // Every card dismissed: say so, rather than leave an inbox that
      // looks broken under "N sessions running".
      const empty = body.createDiv({ cls: "terminus-inbox-empty" });
      setIcon(empty.createDiv({ cls: "terminus-inbox-empty-icon" }), "check-circle");
      empty.createDiv({ cls: "terminus-inbox-empty-title", text: "All caught up" });
      empty.createDiv({ cls: "terminus-inbox-empty-text", text: "A dismissed session comes back here on its next turn." });
      if (this.ui.lastDismissed.some((token) => this.ui.dismissed.has(token))) {
        const undo = empty.createEl("button", { cls: "terminus-btn-ghost", text: "Undo dismiss" });
        undo.addEventListener("click", () => {
          this.ui.userAction();
          for (const token of this.ui.lastDismissed) this.ui.dismissed.delete(token);
          this.ui.lastDismissed = [];
          this.render();
        });
      }
    }

    this.renderElsewhere(body, elsewhere);

    const history = this.plugin.pendingChangesStore.listHistory();
    if (history.length > 0) renderHistorySection(this.rows, body, history);

    // Last, once the content is as tall as it was.
    container.scrollTop = scrollTop;
    this.revealRequested(container);
  }

  /** What the sidebar has selected, as the inbox sees it: the selected
   *  group's name, and which cards belong to it. Ungrouped terminals show in
   *  every group, as in the sidebar; a card whose terminal is gone belongs to
   *  no group and always counts, since its changes still need review. */
  private selection(): { label: string; color: string | null; inScope: (card: InboxCard) => boolean } {
    const groups = this.plugin.groupStore;
    const active = groups.get(groups.activeGroupId);
    const owner = new Map(this.plugin.groups.terminals().map((t) => [t.hookToken, groups.get(t.groupId)?.id ?? null]));
    return {
      label: active?.name ?? "Ungrouped",
      color: active?.color ?? null,
      inScope: (card) => {
        if (!owner.has(card.token)) return true;
        const group = owner.get(card.token);
        return group === null || group === active?.id;
      },
    };
  }

  /** One line under the header saying what the inbox is showing, with the
   *  way out of it. Hidden when there is nothing to scope: no group's
   *  sessions are held back. */
  private renderScope(container: HTMLElement, scope: { label: string; color: string | null }, elsewhere: InboxCard[]): void {
    const showAll = this.ui.showAll;
    if (!showAll && elsewhere.length === 0) return;
    const line = container.createDiv({ cls: "terminus-inbox-scope" });
    const what = line.createSpan({ cls: "terminus-inbox-scope-what" });
    if (showAll) {
      what.setText("Showing all sessions");
    } else {
      if (scope.color) what.createSpan({ cls: "terminus-group-dot" }).style.setProperty("--terminus-group-color", scope.color);
      what.createSpan({ text: `Showing ${scope.label}` });
    }
    const waiting = elsewhere.filter((card) => !card.ended && card.session?.status === "needs-attention").length;
    if (waiting > 0) {
      const alert = line.createEl("button", {
        cls: "terminus-inbox-scope-alert",
        text: `${waiting} elsewhere ${waiting === 1 ? "needs" : "need"} you`,
      });
      setTooltip(alert, "Jump to the next session that needs attention");
      alert.addEventListener("click", () => void this.plugin.jumpToNextSessionNeedingAttention());
    }
    line.createDiv({ cls: "terminus-inbox-spacer" });
    const toggle = line.createEl("button", { cls: "terminus-btn-ghost", text: showAll ? "Follow group" : "Show all" });
    setTooltip(toggle, showAll ? "Show only the group selected in the Terminus sidebar" : "Show every session, whatever its group");
    toggle.addEventListener("click", () => {
      this.ui.userAction();
      this.ui.showAll = !showAll;
      this.render();
    });
  }

  /** The sessions outside the selected group, one line each: enough to see
   *  who needs you and to go there, without a card's weight. */
  private renderElsewhere(body: HTMLElement, cards: InboxCard[]): void {
    if (cards.length === 0) return;
    const collapsed = this.ui.elsewhereCollapsed;
    const heading = this.renderSectionHeading(body, "Elsewhere", cards.length, collapsed);
    const toggle = () => {
      this.ui.userAction();
      this.ui.elsewhereCollapsed = !collapsed;
      this.render();
    };
    heading.addEventListener("click", toggle);
    makeActivatable(heading, toggle, () => undefined);
    heading.setAttr("aria-expanded", String(!collapsed));
    if (collapsed) return;
    for (const card of cards) {
      const { terminal, name, color } = this.identify(card);
      const row = body.createDiv({ cls: "terminus-inbox-elsewhere" });
      row.toggleClass("is-needs-attention", !card.ended && card.session?.status === "needs-attention");
      const swatch = row.createSpan({ cls: "terminus-inbox-card-stroke" });
      if (color) swatch.style.setProperty("--terminus-terminal-color", color);
      row.createSpan({ cls: "terminus-inbox-elsewhere-name", text: name, attr: { title: name } });
      const group = this.plugin.groupStore.get(terminal?.groupId);
      if (group && group.name !== name) row.createSpan({ cls: "terminus-inbox-elsewhere-group", text: group.name });
      const pill = statusPill(card);
      setTooltip(row.createSpan({ cls: `terminus-inbox-pill is-${pill.kind}`, text: pill.label }), pill.hint);
      if (card.changes.length > 0) row.createSpan({ cls: "terminus-inbox-elsewhere-review", text: `${card.changes.length} to review` });
      if (terminal) {
        const open = () => void this.plugin.focusTerminal(card.token);
        row.addEventListener("click", open);
        makeActivatable(row, open, () => undefined);
      }
    }
  }

  /** A card's terminal, name and colour. The name falls back to what a
   *  closed terminal left behind. */
  private identify(card: InboxCard): { terminal: TerminalView | null; name: string; color: string | null } {
    const terminal = this.plugin.findTerminalView(card.token);
    const firstChange = card.changes[0];
    return {
      terminal,
      name:
        terminal?.getDisplayText() ??
        firstChange?.panelLabel ??
        this.plugin.feedbackStore.listFor(card.token)[0]?.terminalLabel ??
        "Closed terminal",
      color: terminal ? terminal.effectiveColor : (firstChange?.panelColor ?? null),
    };
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

  /** A finished card can be dismissed once nothing on it is waiting on
   *  you: no pending changes (Keep or Reject them) and no queued comments. */
  private dismissible(card: InboxCard): boolean {
    return card.changes.length === 0 && this.plugin.feedbackStore.listFor(card.token).length === 0;
  }

  private dismiss(cards: InboxCard[]): void {
    this.ui.userAction();
    this.ui.lastDismissed = cards.map((card) => card.token);
    for (const card of cards) {
      this.ui.dismissed.add(card.token);
      this.plugin.agentSessionStore.seen(card.token);
    }
    this.render();
  }

  private renderCard(body: HTMLElement, card: InboxCard, inFinished = false): void {
    const { terminal, name, color } = this.identify(card);
    const session = card.session;
    const needsAttention = !card.ended && session?.status === "needs-attention";
    const collapsed = this.ui.collapsedCards.has(card.token);

    const el = body.createDiv({ cls: "terminus-inbox-card" });
    el.toggleClass("is-needs-attention", needsAttention);
    el.dataset.token = card.token;
    el.toggleClass("is-ended", card.ended);
    el.toggleClass("is-focused", card.token === this.focusedToken);
    const head = el.createDiv({ cls: "terminus-inbox-card-head" });
    // The terminal's colour as a short stroke, like its tab and its row in
    // the sidebar; a group's colour is a dot.
    const swatch = head.createSpan({ cls: "terminus-inbox-card-stroke" });
    if (color) swatch.style.setProperty("--terminus-terminal-color", color);
    head.createSpan({ cls: "terminus-inbox-card-name", text: name });
    const pill = statusPill(card);
    setTooltip(head.createSpan({ cls: `terminus-inbox-pill is-${pill.kind}`, text: pill.label }), pill.hint);
    setIcon(head.createSpan({ cls: "terminus-inbox-chevron" }), collapsed ? "chevron-right" : "chevron-down");
    const toggle = () => {
      this.ui.userAction();
      if (collapsed) this.ui.collapsedCards.delete(card.token);
      else this.ui.collapsedCards.add(card.token);
      this.render();
    };
    head.addEventListener("click", toggle);
    makeActivatable(head, toggle, () => undefined);
    head.setAttr("aria-expanded", String(!collapsed));

    const meta = el.createDiv({ cls: "terminus-inbox-card-meta" });
    const group = this.plugin.groupStore.get(terminal?.groupId);
    // A terminal and its group often share a name (both taken from Claude's
    // title); the group's then adds nothing but a repeat.
    if (group && group.name !== name) {
      const groupLabel = meta.createSpan({ cls: "terminus-inbox-group" });
      groupLabel.createSpan({ cls: "terminus-group-dot" }).style.setProperty("--terminus-group-color", group.color);
      groupLabel.createSpan({ text: group.name });
      setTooltip(groupLabel, "This terminal's group");
    }
    // `claude --agent reviewer`: the session itself is one of the user's
    // agents, so the card says which.
    if (session?.agentName) {
      setTooltip(iconLabel(meta, "bot", session.agentName, "terminus-inbox-agent-name-meta"), `Runs as the ${session.agentName} agent`);
    }
    if (session?.branch && this.plugin.settings.multiAgent.showGitBranch) {
      setTooltip(iconLabel(meta, "git-branch", session.branch, "terminus-inbox-branch"), "Git branch of this session's folder");
    }
    if (session?.lastTurnMs != null && session.status !== "working") {
      meta.createSpan({ text: `turn ${formatDuration(session.lastTurnMs)}` });
    } else if (!card.ended && session?.status === "working" && session.turnStartedAt !== null) {
      liveElapsed(meta, session.turnStartedAt, "turn so far");
    }
    // A folded card has no agent rows, so its agents are counted in a line.
    const agents = collapsed ? summarizeAgents(session?.subagents ?? []) : null;
    if (agents) meta.createSpan({ cls: "terminus-inbox-agents-summary", text: agents });
    this.renderUsage(meta, sessionUsage(session), session?.usage ?? null);
    if (card.changes.length > 0) {
      const { added, removed } = sumStats(card.changes);
      // One unit, so a narrow card wraps before it rather than inside it.
      const pending = meta.createSpan({ cls: "terminus-inbox-pending" });
      pending.createSpan({ text: `${card.changes.length} to review` });
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
    if (card.subagents.length === 0) {
      if (card.leadChanges.length > 0) this.renderChangeList(workEl.createDiv({ cls: "terminus-inbox-changes" }), card.leadChanges, card, null);
    } else {
      this.renderAgents(workEl, card);
    }

    this.renderFeedback(workEl, card.token, name);
    this.renderDelegations(workEl, card.token, name);
    this.renderSteer(workEl, card, name);
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
    } else if (inFinished && this.dismissible(card)) {
      const dismiss = foot.createEl("button", { cls: "terminus-btn-ghost", text: "Dismiss" });
      setTooltip(dismiss, "Hide this card until the session's next turn");
      dismiss.addEventListener("click", () => this.dismiss([card]));
    } else {
      foot.createSpan({ cls: "terminus-inbox-foot-note", text: "Nothing to review" });
    }
    foot.createDiv({ cls: "terminus-inbox-spacer" });
    if (terminal) {
      foot.createEl("button", { cls: "terminus-btn-ghost", text: "Open terminal" }).addEventListener("click", () =>
        void this.plugin.focusTerminal(card.token)
      );
    }
  }

  /**
   * "Tell this session…": a box on a running session's card, to steer it.
   * "Add to input" types the text into the session's input line for the
   * user to send; "Send now" types it and presses Enter. Claude queues text
   * entered mid-turn and folds it into the running turn, so this works while
   * it works. Cmd/Ctrl+Enter is Send now. The draft is kept in the plugin's
   * inbox state, so folding the card or re-rendering doesn't lose it.
   */
  private renderSteer(el: HTMLElement, card: InboxCard, name: string): void {
    const token = card.token;
    if (card.ended || !this.plugin.agentSessionStore.get(token)?.running || !this.plugin.findTerminalView(token)) return;
    const readiness = this.plugin.steerReadiness(token);
    const section = el.createDiv({ cls: "terminus-inbox-steer" });
    const input = section.createEl("textarea", {
      cls: "terminus-inbox-steer-input",
      attr: { rows: "2", placeholder: `Tell ${name}…  (${Platform.isMacOS ? "⌘" : "Ctrl"}↵ sends now)` },
    });
    input.value = this.ui.drafts.get(token) ?? "";
    input.addEventListener("input", () => {
      if (input.value) this.ui.drafts.set(token, input.value);
      else this.ui.drafts.delete(token);
    });
    input.addEventListener("blur", () => {
      if (!this.renderSkipped) return;
      this.renderSkipped = false;
      this.render();
    });

    const actions = section.createDiv({ cls: "terminus-inbox-steer-actions" });
    const add = actions.createEl("button", { cls: "terminus-btn-ghost", text: "Add to input" });
    setTooltip(add, "Types it into the session's input line and takes you to the terminal; you press Enter");
    const send = actions.createEl("button", { cls: "terminus-btn-ghost-accent", text: "Send now" });
    setTooltip(send, "Types it into the session's input line and presses Enter");
    if (!readiness.ready) {
      add.disabled = true;
      send.disabled = true;
      actions.createSpan({ cls: "terminus-inbox-foot-note", text: readiness.reason });
    }
    const deliver = async (submit: boolean) => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      if (!(await this.plugin.sendGuidance(token, text, submit))) return;
      this.ui.drafts.delete(token);
      input.value = "";
      input.blur();
      this.render();
    };
    add.addEventListener("click", () => void deliver(false));
    send.addEventListener("click", () => void deliver(true));
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        if (readiness.ready) void deliver(true);
      }
    });
  }

  /**
   * Tasks sent from this session to new terminals ("Send to a new
   * terminal…"), each with how its session is doing and, once its turn has
   * ended, its closing message: to open, to type back into this session's
   * input line (between turns, unsubmitted), or to dismiss.
   */
  private renderDelegations(el: HTMLElement, token: string, parentName: string): void {
    const delegations = this.plugin.delegationStore.forParent(token);
    if (delegations.length === 0) return;
    const section = el.createDiv({ cls: "terminus-inbox-delegations" });
    for (const delegation of delegations) {
      const child = this.plugin.findTerminalView(delegation.childToken);
      const childName = child?.getDisplayText() ?? delegation.childLabel;
      const session = this.plugin.agentSessionStore.get(delegation.childToken);
      const done = !!session && session.lastTurnEndedAt !== null && session.status !== "working";
      const waiting = session?.status === "needs-attention";
      const row = section.createDiv({ cls: "terminus-inbox-delegation" });
      const head = row.createDiv({ cls: "terminus-inbox-delegation-head" });
      setIcon(head.createSpan({ cls: "terminus-meta-icon" }), "corner-down-right");
      head.createSpan({ cls: "terminus-inbox-delegation-name", text: childName, attr: { title: delegation.task } });
      // The same words as a card's pill: "Ready" until its first turn.
      const pill = !session?.running && !done
        ? { kind: "ended", label: "Session ended" }
        : waiting
          ? { kind: "needs-attention", label: "Waiting for you" }
          : session?.status === "working"
            ? { kind: "working", label: "Working" }
            : done
              ? { kind: "finished", label: "Finished" }
              : { kind: "idle", label: "Ready" };
      head.createSpan({ cls: `terminus-inbox-pill is-${pill.kind}`, text: pill.label });
      if (done && session?.lastMessage) {
        const result = plainPreview(session.lastMessage);
        row.createDiv({ cls: "terminus-inbox-quote", text: result, attr: { title: result } });
      }
      const actions = row.createDiv({ cls: "terminus-inbox-delegation-actions" });
      if (child) actions.createEl("button", { cls: "terminus-btn-ghost", text: "Open terminal" }).addEventListener("click", () => void this.plugin.focusTerminal(delegation.childToken));
      if (done && session?.lastMessage) {
        const readiness = this.plugin.feedbackReadiness(token);
        if (readiness.ready) {
          const send = actions.createEl("button", { cls: "terminus-btn-ghost-accent", text: `Send to ${parentName}` });
          setTooltip(send, "Types the result into this session's input line without sending it");
          send.addEventListener("click", () => void this.plugin.sendDelegationResult(delegation.childToken));
        } else {
          actions.createSpan({ cls: "terminus-inbox-foot-note", text: readiness.reason });
        }
      }
      actions.createDiv({ cls: "terminus-inbox-spacer" });
      actions.createEl("button", { cls: "terminus-btn-ghost", text: "Dismiss" }).addEventListener("click", () => this.plugin.delegationStore.remove(delegation.childToken));
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

  /**
   * A card with subagents, as a list of agents, each with the files it
   * changed hanging under it: first the agents that changed something (the
   * lead too, when it did), then ones still running or that failed. Agents
   * that finished with nothing pending fold into one line, so they don't
   * sit between an agent and the next one's files.
   */
  private renderAgents(el: HTMLElement, card: InboxCard): void {
    const needsRow = (sub: InboxSubagent) => sub.changes.length > 0 || sub.run?.running === true || sub.run?.outcome === "failed";
    const withChanges = card.subagents.filter((sub) => sub.changes.length > 0);
    const busy = card.subagents.filter((sub) => sub.changes.length === 0 && needsRow(sub));
    const quiet = card.subagents.filter((sub) => !needsRow(sub));

    if (card.leadChanges.length > 0) {
      this.renderAgent(el, card, {
        agentId: null,
        mark: { kind: "lead", icon: "bot", label: "Lead session" },
        name: "Lead",
        secondary: "main session",
        details: [],
        changes: card.leadChanges,
      });
    }
    for (const sub of [...withChanges, ...busy]) this.renderSubagent(el, card, sub, false);

    const quietCount = quiet.length + card.hiddenSubagents;
    if (quietCount === 0) return;
    const expanded = this.ui.expandedQuiet.has(card.token);
    const fold = el.createDiv({ cls: "terminus-inbox-quiet" });
    const toggle = fold.createDiv({ cls: "terminus-inbox-quiet-toggle" });
    setIcon(toggle.createSpan({ cls: "terminus-inbox-chevron" }), expanded ? "chevron-down" : "chevron-right");
    // "Nothing to review" rather than "no changes": an agent whose changes
    // were kept or rejected folds here too.
    toggle.createSpan({ text: `${quietCount} ${quietCount === 1 ? "agent" : "agents"} with nothing to review` });
    const flip = () => {
      this.ui.userAction();
      if (expanded) this.ui.expandedQuiet.delete(card.token);
      else this.ui.expandedQuiet.add(card.token);
      this.render();
    };
    toggle.addEventListener("click", flip);
    makeActivatable(toggle, flip, () => undefined);
    toggle.setAttr("aria-expanded", String(expanded));
    if (!expanded) return;
    for (const sub of quiet) this.renderSubagent(fold, card, sub, true);
    if (card.hiddenSubagents > 0) {
      fold.createDiv({ cls: "terminus-inbox-more", text: `and ${card.hiddenSubagents} earlier` });
    }
  }

  private renderSubagent(el: HTMLElement, card: InboxCard, sub: InboxSubagent, compact: boolean): void {
    const running = sub.run?.running ?? false;
    const details: string[] = [];
    const time = subagentTime(sub.run);
    if (time) details.push(time);
    const failed = sub.run?.outcome === "failed" && sub.run.error ? sub.run.error : null;
    // Named by its task ("Division note long form"), which is what tells
    // one agent from another; the type ("general-purpose") is secondary.
    const task = sub.run?.description ?? null;
    this.renderAgent(el, card, {
      agentId: sub.agentId,
      mark: subagentMark(sub.run),
      name: task ?? sub.agentType,
      // A teammate's type is its name in the team.
      secondary: sub.run?.teammate ? `teammate ${sub.agentType}` : task ? sub.agentType : null,
      details: compact ? [] : details,
      usage: compact ? null : (sub.run?.usage ?? null),
      changes: sub.changes,
      liveSince: running ? sub.run?.startedAt : null,
      error: failed,
      title: !failed && sub.run?.lastMessage && !running ? sub.run.lastMessage : null,
      compact,
    });
  }

  /** One agent on a card -- the lead or a subagent -- always in the same
   *  shape: a status mark, its name and task, a line of details, then its
   *  changes indented underneath. */
  private renderAgent(
    el: HTMLElement,
    card: InboxCard,
    agent: {
      agentId: string | null;
      mark: { kind: string; icon: string | null; label: string };
      name: string;
      secondary: string | null;
      details: string[];
      usage?: UsageTotals | null;
      changes: PendingChange[];
      error?: string | null;
      title?: string | null;
      compact?: boolean;
      /** A running agent's start, for a timer that ticks in place. */
      liveSince?: number | null;
    }
  ): void {
    const row = el.createDiv({ cls: "terminus-inbox-agent" });
    row.toggleClass("is-compact", agent.compact === true);
    row.toggleClass("has-changes", agent.changes.length > 0);
    const line = row.createDiv({ cls: "terminus-inbox-agent-line" });
    const markEl = line.createSpan({ cls: `terminus-inbox-agent-mark is-${agent.mark.kind}`, attr: { "aria-label": agent.mark.label } });
    // Running is a pulsing dot drawn in CSS; the rest are icons.
    if (agent.mark.icon) setIcon(markEl, agent.mark.icon);
    // The task gets the line to itself: it's what tells agents apart.
    line.createSpan({ cls: "terminus-inbox-agent-name", text: agent.name, attr: { title: agent.name } });
    // Totals only over several files; one file's own row has its counts.
    if (agent.changes.length > 1) {
      const { added, removed } = sumStats(agent.changes);
      const stats = line.createSpan({ cls: "terminus-inbox-agent-stats" });
      stats.createSpan({ text: changeCount(agent.changes.length) });
      stats.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
      stats.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
    }

    const detailText = [...(agent.secondary && !agent.compact ? [agent.secondary] : []), ...agent.details];
    if (detailText.length > 0 || agent.usage || agent.liveSince) {
      const details = row.createDiv({ cls: "terminus-inbox-agent-details" });
      for (const detail of detailText) details.createSpan({ text: detail });
      if (agent.liveSince && !agent.compact) liveElapsed(details, agent.liveSince, "running");
      if (agent.usage) this.renderUsage(details, agent.usage, agent.usage);
    }
    if (agent.error) {
      // First line only; the full error is on hover.
      row.createDiv({ cls: "terminus-inbox-agent-error", text: agent.error.split("\n")[0] ?? "", attr: { title: agent.error } });
    } else if (agent.title) {
      row.setAttr("title", agent.title);
    }

    if (agent.changes.length > 0) this.renderChangeList(row.createDiv({ cls: "terminus-inbox-agent-changes" }), agent.changes, card, agent.agentId);
  }

  /** `owner` is the agent the rows sit under (null: the lead); a file that
   *  other agents in this session also edited says which. A long list over
   *  several folders is grouped by folder, each foldable. */
  private renderChangeList(parent: HTMLElement, changes: PendingChange[], card: InboxCard, owner: string | null): void {
    if (changes.length === 0) return;
    const list = parent.createDiv({ cls: "terminus-pending-list" });
    const row = (target: HTMLElement, change: PendingChange, hideFolder: boolean) => {
      const others = change.agents.filter((a) => a.token === card.token && a.agentId !== owner).map((a) => agentLabel(card, a.agentId, a.agentType));
      renderChangeRow(this.rows, target, change, computeDiffStats(change.diff), { alsoEditedBy: others, hideFolder });
    };
    const folders = changes.length >= TREE_MIN_FILES ? this.groupByFolder(changes) : null;
    if (!folders || folders.length < 2) {
      for (const change of changes) row(list, change, false);
      return;
    }

    const keyOf = (folder: string) => `${card.token}|${owner ?? ""}|${folder}`;
    const { added, removed } = sumStats(changes);
    const allFolded = folders.every((f) => this.ui.collapsedFolders.has(keyOf(f.folder)));
    const head = list.createDiv({ cls: "terminus-inbox-tree-head" });
    head.createSpan({ text: `${changes.length} changed files` });
    head.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
    head.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
    head.createDiv({ cls: "terminus-inbox-spacer" });
    iconButton(head, allFolded ? "chevrons-up-down" : "chevrons-down-up", allFolded ? "Expand all folders" : "Collapse all folders", () => {
      this.ui.userAction();
      for (const f of folders) {
        if (allFolded) this.ui.collapsedFolders.delete(keyOf(f.folder));
        else this.ui.collapsedFolders.add(keyOf(f.folder));
      }
      this.render();
    });

    for (const { folder, changes: inFolder } of folders) {
      const key = keyOf(folder);
      const folded = this.ui.collapsedFolders.has(key);
      const heading = list.createDiv({ cls: "terminus-inbox-folder" });
      setIcon(heading.createSpan({ cls: "terminus-inbox-chevron" }), folded ? "chevron-right" : "chevron-down");
      iconLabel(heading, "folder", folder || "Vault root", "terminus-inbox-folder-name");
      heading.createSpan({ cls: "terminus-inbox-folder-count", text: String(inFolder.length) });
      const toggle = () => {
        this.ui.userAction();
        if (folded) this.ui.collapsedFolders.delete(key);
        else this.ui.collapsedFolders.add(key);
        this.render();
      };
      heading.addEventListener("click", toggle);
      makeActivatable(heading, toggle, () => undefined);
      heading.setAttr("aria-expanded", String(!folded));
      if (!folded) for (const change of inFolder) row(list, change, true);
    }
  }

  /** The changes by folder, vault-relative (a file outside the vault by its
   *  own folder), in the order each folder first appears. */
  private groupByFolder(changes: PendingChange[]): Array<{ folder: string; changes: PendingChange[] }> {
    const base = this.plugin.getVaultBasePath();
    const byFolder = new Map<string, PendingChange[]>();
    for (const change of changes) {
      const relative = pathRelative(base, change.diff.filePath);
      const path = relative.startsWith("..") ? change.diff.filePath : relative;
      const folder = path.split("/").slice(0, -1).join("/");
      const list = byFolder.get(folder) ?? [];
      list.push(change);
      byFolder.set(folder, list);
    }
    return [...byFolder].map(([folder, list]) => ({ folder, changes: list }));
  }
}

/** A list this long, over several folders, is grouped by folder. */
const TREE_MIN_FILES = 6;

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

/** The card's pill, and what it means on hover. */
function statusPill(card: InboxCard): { kind: string; label: string; hint: string } {
  const session = card.session;
  if (card.ended || !session) return { kind: "ended", label: "Session ended", hint: "Claude has exited. The card stays until its changes are reviewed." };
  switch (session.status) {
    case "needs-attention":
      return {
        kind: "needs-attention",
        label: session.needs === "permission" ? "Needs permission" : session.needs === "input" || session.needs === "unread-turn" ? "Waiting for you" : "Needs attention",
        hint: "Claude is waiting on you in the terminal",
      };
    case "working":
      return { kind: "working", label: "Working", hint: "Claude is mid-turn" };
    case "finished-unread":
      return { kind: "finished", label: "Finished", hint: "The turn ended and you haven't looked at it yet" };
    case "idle":
      // Started but no turn yet: nothing has finished.
      return session.lastTurnEndedAt === null
        ? { kind: "idle", label: "Ready", hint: "Claude is running and waiting for a first prompt" }
        : { kind: "idle", label: "Idle", hint: "Claude is waiting for your next prompt" };
  }
}

/** Claude's messages are Markdown; the two-line preview shows them as
 *  plain text rather than with their `**` and backticks. */
export function plainPreview(markdown: string): string {
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

/** What a card calls one of its agents: "Lead", or a subagent's task. */
function agentLabel(card: InboxCard, agentId: string | null, agentType: string | null): string {
  if (!agentId) return "Lead";
  const run = card.session?.subagents.find((r) => r.agentId === agentId);
  return run?.description ?? run?.agentType ?? agentType ?? "a subagent";
}

/** "running 2m 14s", counting up on its own (see tickElapsed). */
function liveElapsed(parent: HTMLElement, since: number, label: string): void {
  const el = parent.createSpan();
  el.appendText(`${label} `);
  el.createSpan({ cls: "terminus-inbox-live-elapsed", text: formatDuration(Date.now() - since), attr: { "data-since": String(since) } });
}

/** "3 agents · 2 working · 1 failed" for a folded card; null with none.
 *  Agents that finished fine are only counted in the first part. */
function summarizeAgents(runs: SubagentRun[]): string | null {
  if (runs.length === 0) return null;
  const working = runs.filter((r) => r.running).length;
  const failed = runs.filter((r) => !r.running && r.outcome === "failed").length;
  const stopped = runs.filter((r) => !r.running && r.outcome === "stopped").length;
  const parts = [`${runs.length} ${runs.length === 1 ? "agent" : "agents"}`];
  if (working > 0) parts.push(`${working} working`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  return parts.join(" · ");
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
