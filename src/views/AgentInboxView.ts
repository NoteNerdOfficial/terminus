import { ItemView, Menu, Platform, setIcon, setTooltip, WorkspaceLeaf } from "obsidian";
import { pathRelative } from "terminus-node-bridge";
import { activeTime, type AgentSession, type SubagentRun } from "../state/AgentSessionStore";
import { addUsage, formatModelName, totalTokens, UsageTotals } from "../claude/transcriptUsage";
import { PendingChange } from "../state/PendingChangesStore";
import { changesOwnedElsewhere, changesStartedElsewhere, groupOverlaps, hasCollision } from "../modals/collisions";
import { buildInbox, InboxCard, InboxSubagent, InboxTurn, scopeInbox } from "../state/inboxModel";
import type { InboxUiState } from "../state/InboxUiState";
import { TerminalView } from "./TerminalView";
import { computeDiffStats } from "../diff/renderDiff";
import { openDiffSplitView } from "./DiffSplitView";
import { openChangedFile } from "../editor/openWithDiff";
import { ActionLogModal } from "../modals/ActionLogModal";
import {
  ChangeRowContext,
  SHELL_CHANGE_TOOLTIP,
  renderChangeRow,
  renderHistorySection,
  renderShellChangeRows,
  runBulkAction,
} from "./changeRows";
import { guardRenderDuringPress } from "./renderGuard";
import { groupIcon, iconButton, iconLabel, makeActivatable } from "./uiHelpers";
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
  /** Pending frame for the pinned-header pass; null when none is queued. */
  private stuckFrame: number | null = null;
  /** The queued message being edited in place, if any. */
  private editingQueueId: number | null = null;
  /** Whether the header's overlap popover is showing. Lives on the view,
   *  not in InboxUiState, because it is dismissed by the next click and
   *  so never needs to survive a view being closed and reopened. */
  private overlapOpen = false;
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
    this.plugin.steerQueue.on("change", this.render);
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
    // Pinned headers grow a hairline while rows pass under them; nothing
    // else here cares about scrolling, so one throttled listener does it.
    this.registerDomEvent(this.contentEl, "scroll", () => this.queueStuckPass());
    // The overlap popover closes on the next click outside it and on
    // Escape, like Obsidian's own menus. Registered once rather than per
    // render, and cheap: both return immediately while it is closed.
    this.registerDomEvent(document, "click", (evt) => {
      if (!this.overlapOpen) return;
      const target = evt.target;
      if (target instanceof Node && this.contentEl.querySelector(".terminus-inbox-overlap-pop")?.contains(target)) return;
      if (target instanceof Node && this.contentEl.querySelector(".terminus-inbox-overlap-chip")?.contains(target)) return;
      this.overlapOpen = false;
      this.render();
    });
    this.registerDomEvent(document, "keydown", (evt) => {
      if (!this.overlapOpen || evt.key !== "Escape") return;
      this.overlapOpen = false;
      this.render();
    });
    this.render();
  }

  /**
   * `position: sticky` has no state of its own, so a pinned header is found
   * by comparing its box to the offset it would rest at. Runs on a frame so
   * a fling doesn't do this once per scroll event.
   */
  private queueStuckPass(): void {
    if (this.stuckFrame !== null) return;
    this.stuckFrame = window.requestAnimationFrame(() => {
      this.stuckFrame = null;
      this.markStuck();
    });
  }

  private markStuck(): void {
    const container = this.contentEl;
    // Sticky offsets are measured from the scroll container's content box,
    // so a header's resting place is that edge plus its own offset -- which
    // is itself negative by the pane's padding (see measureStickyOffsets).
    const style = window.getComputedStyle(container);
    const top = container.getBoundingClientRect().top + container.clientTop + (Number.parseFloat(style.paddingTop) || 0);
    // At rest the topmost header sits at its own offset anyway, and nothing
    // is passing under it yet.
    const scrolled = container.scrollTop > 0;
    const heads = Array.from(container.querySelectorAll<HTMLElement>(STICKY_HEADS));
    const pinned = scrolled
      ? heads.filter((el) => {
          const offset = Number.parseFloat(window.getComputedStyle(el).top) || 0;
          return Math.abs(el.getBoundingClientRect().top - top - offset) < 1;
        })
      : [];
    // The levels stack in document order, so the last pinned header is the
    // bottom of the stack -- the one edge rows actually pass under. Ruling
    // the seams between pinned headers too would stripe the whole stack.
    // `is-pinned` is the wider state: a pinned card top redraws the card's
    // own top border, which by then has scrolled away above it.
    const edge = pinned.at(-1);
    const held = new Set(pinned);
    for (const el of heads) {
      el.toggleClass("is-pinned", held.has(el));
      el.toggleClass("is-stuck", el === edge);
    }
  }

  /**
   * Each pinned level parks directly under the one above it, so it needs the
   * measured height of the levels above -- not a constant, because a theme's
   * interface font decides it.
   *
   * Section headings share one number, which CSS hands back as a
   * `min-height`: a "Clear" button makes one taller than its neighbours, and
   * a card pinned under the short one would otherwise leave a gap. Card tops
   * and turn headers legitimately differ -- a banner, a two-line message, a
   * fold-all icon -- so each publishes its own height to its own subtree
   * instead, floored, so neighbours overlap by a fraction rather than
   * showing a sliver of a row through the seam.
   */
  private measureStickyOffsets(container: HTMLElement): void {
    const style = window.getComputedStyle(container);
    // A theme's pane padding sits above the first level, and sticky counts
    // offsets from the content box -- so without this the headers would park
    // a padding's worth down the pane and rows would scroll through the gap
    // above them.
    container.style.setProperty("--terminus-stick-top", `${-(Number.parseFloat(style.paddingTop) || 0)}px`);
    let section = 0;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(".terminus-inbox-section"))) {
      section = Math.max(section, el.getBoundingClientRect().height);
    }
    container.style.setProperty("--terminus-section-h", `${Math.ceil(section)}px`);
    const publish = (owner: string, head: string, name: string): void => {
      for (const el of Array.from(container.querySelectorAll<HTMLElement>(owner))) {
        const box = el.querySelector<HTMLElement>(head);
        el.style.setProperty(name, `${box ? Math.floor(box.getBoundingClientRect().height) : 0}px`);
      }
    };
    publish(".terminus-inbox-card", ".terminus-inbox-card-top", "--terminus-card-head-h");
    publish(".terminus-inbox-turn", ".terminus-inbox-turn-head", "--terminus-turn-head-h");
    // A pinned header has to be opaque, and which Obsidian variable the
    // pane's own background came from depends on where the view is docked
    // and what the theme did to it -- so read it rather than guess.
    container.style.setProperty("--terminus-pane-bg", opaqueBackground(container));
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
      // `data-base` is time already banked (finished turns, for a session's
      // running total); 0 for a plain "how long has this been going" timer.
      el.setText(formatDuration(Number(el.dataset.base ?? 0) + Date.now() - Number(el.dataset.since)));
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
    if (this.stuckFrame !== null) window.cancelAnimationFrame(this.stuckFrame);
    this.stuckFrame = null;
    this.plugin.pendingChangesStore.off("change", this.render);
    this.plugin.agentSessionStore.off("change", this.render);
    this.plugin.feedbackStore.off("change", this.render);
    this.plugin.steerQueue.off("change", this.render);
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
      const section = body.createDiv({ cls: "terminus-inbox-section-group" });
      const heading = this.renderSectionHeading(section, "Finished", finished.length, this.ui.finishedCollapsed);
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
      if (!this.ui.finishedCollapsed) for (const card of finished) this.renderCard(section, card, true);
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
    // Both read layout, so they run after the scroll position is back.
    this.measureStickyOffsets(container);
    this.markStuck();
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
      if (scope.color) groupIcon(what, scope.color);
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
      if (group && group.name !== name) {
        const where = row.createSpan({ cls: "terminus-inbox-elsewhere-group" });
        groupIcon(where, group.color);
        where.createSpan({ text: group.name });
      }
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
  /**
   * The overlap popover: the two requests that collided, in the user's own
   * words, and the files they both touched. It resolves nothing. Every row
   * leads to Split diff, where both versions sit side by side and changes
   * are picked one at a time, which is the only tool that can separate two
   * sessions' work within a file.
   */
  private renderOverlapPopover(header: HTMLElement, overlaps: PendingChange[]): void {
    const pop = header.createDiv({ cls: "terminus-inbox-overlap-pop" });
    // Clicks inside must not reach the document handler that closes it.
    pop.addEventListener("click", (evt) => evt.stopPropagation());
    const groups = groupOverlaps(overlaps);
    for (const group of groups) {
      const block = pop.createDiv({ cls: "terminus-inbox-overlap-group" });
      this.renderOverlapAsk(block, group.first.token, group.first.label, group.first.color, group.changes);
      const divider = block.createDiv({ cls: "terminus-inbox-overlap-then" });
      divider.createSpan({ cls: "terminus-inbox-overlap-line" });
      divider.createSpan({ text: "overwritten by" });
      divider.createSpan({ cls: "terminus-inbox-overlap-line" });
      this.renderOverlapAsk(block, group.last.token, group.laterLabel, group.last.color, group.changes);
      const files = block.createDiv({ cls: "terminus-inbox-overlap-files" });
      for (const change of group.changes) this.renderOverlapRow(files, change);
    }
    const last = groups[groups.length - 1];
    const foot = pop.createDiv({ cls: "terminus-inbox-overlap-foot" });
    if (groups.length === 1 && last) {
      // Deliberately not "the first session's work is gone": whether it is
      // depends on whether the later edit was a whole-file Write or an Edit
      // that left the rest alone, which this cannot know (see
      // server/diff.ts). Saying so sends the user to look instead.
      foot.setText(
        `Each of these files now holds ${last.laterLabel}'s version. ` +
          `Anything ${last.first.label} wrote is only still in there if ${last.laterLabel} kept it. ` +
          "Open one to see what changed."
      );
    } else {
      foot.setText(
        "Each of these files now holds the later session's version. " +
          "Anything the earlier one wrote is only still in there if the later one kept it. " +
          "Open one to see what changed."
      );
    }
  }

  /** One side of the collision: the request, and who made it. */
  private renderOverlapAsk(block: HTMLElement, token: string, label: string, color: string | null, changes: PendingChange[]): void {
    const prompt = this.promptFor(token, changes);
    const quote = block.createDiv({ cls: "terminus-inbox-overlap-ask" });
    quote.setText(prompt ? `“${plainPreview(prompt)}”` : "Request not recorded");
    quote.toggleClass("is-unrecorded", prompt === null);
    if (prompt) setTooltip(quote, prompt, { placement: "top" });
    const by = block.createDiv({ cls: "terminus-inbox-overlap-by" });
    const dot = by.createSpan({ cls: "terminus-inbox-overlap-dot" });
    if (color) dot.style.backgroundColor = color;
    by.createSpan({ text: label });
  }

  /**
   * A plain file row: name, folder, counts, and a chevron that says it
   * opens something. Nothing marks it as overlapping, because inside this
   * popover every row is.
   */
  private renderOverlapRow(host: HTMLElement, change: PendingChange): void {
    const row = host.createEl("button", { cls: "terminus-inbox-overlap-row" });
    const name = row.createDiv({ cls: "terminus-inbox-overlap-name" });
    const relative = pathRelative(this.plugin.getVaultBasePath(), change.diff.filePath);
    const parts = relative.split("/");
    name.createSpan({ cls: "terminus-inbox-overlap-file", text: parts[parts.length - 1] ?? relative });
    const folder = parts.slice(0, -1).join("/");
    if (folder) name.createSpan({ cls: "terminus-inbox-overlap-folder", text: folder });
    const { added, removed } = sumStats([change]);
    const stats = row.createSpan({ cls: "terminus-inbox-overlap-stats" });
    stats.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
    stats.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
    // NotebookEdit has no usable Split diff (its oldText/newText are a
    // display-only approximation), so those rows open the file instead.
    const split = change.payload.tool_name !== "NotebookEdit";
    setIcon(row.createSpan({ cls: "terminus-inbox-overlap-go" }), "chevron-right");
    setTooltip(row, split ? `Compare ${parts[parts.length - 1] ?? relative} in Split diff` : "Open it");
    row.addEventListener("click", () => {
      this.overlapOpen = false;
      this.render();
      if (split) void openDiffSplitView(this.plugin, change.id);
      else void openChangedFile(this.plugin, change);
    });
  }

  /** The prompt a session asked, for whichever of these changes it made.
   *  Null when no turn record carries it: the session may have ended, the
   *  record may have fallen past the store's cap, or the hooks may have
   *  gone in mid-turn. */
  private promptFor(token: string, changes: PendingChange[]): string | null {
    const turns = this.plugin.agentSessionStore.get(token)?.turns ?? [];
    for (const change of changes) {
      for (const promptId of change.promptIds) {
        const record = turns.find((t) => t.promptId === promptId);
        if (record?.prompt) return record.prompt;
      }
    }
    return null;
  }

  /**
   * On the card that owns the rows, when an earlier session started some of
   * them. The files here are this session's version, so there is nothing to
   * say about content. What is worth saying is that the row's revertText
   * predates this session: rejecting reaches back past it into the earlier
   * terminal's work, which is the one consequence the card cannot show.
   */
  private renderTurnOverlapNote(host: HTMLElement, token: string, changes: PendingChange[]): void {
    const owned = changesStartedElsewhere(changes, token);
    if (owned.length === 0) return;
    const names = [...new Set(owned.map((c) => c.contributors[0]?.label ?? "another session"))];
    const who = names.length === 1 ? names[0] : "Earlier sessions";
    const note = host.createDiv({ cls: "terminus-inbox-overlap-note" });
    setIcon(note.createSpan({ cls: "terminus-meta-icon" }), "corner-down-right");
    const count = owned.length === 1 ? "one of these files" : `${owned.length} of these files`;
    const it = owned.length === 1 ? "it" : "them";
    note.createSpan({
      text:
        `${who} changed ${count} first. Rejecting ${it} goes back to before ` +
        `${who} started, not just this request.`,
    });
  }

  /**
   * On the card of a session whose overlapping edits are filed elsewhere.
   * buildInbox puts a change on the card of the terminal that edited it
   * FIRST, so a session that rewrote someone else's file never lists it,
   * and a card with nothing else pending can be dismissed while that work
   * waits. This is the only place that says so.
   */
  private renderOwnedElsewhere(host: HTMLElement, card: InboxCard, allChanges: PendingChange[]): void {
    const elsewhere = changesOwnedElsewhere(allChanges, card.token);
    if (elsewhere.length === 0) return;
    const owners = [
      ...new Set(elsewhere.map((c) => c.contributors[c.contributors.length - 1]?.label ?? "another session")),
    ];
    const owner = owners.length === 1 ? owners[0] : "other sessions";
    const line = host.createDiv({ cls: "terminus-inbox-overlap-elsewhere" });
    setIcon(line.createSpan({ cls: "terminus-meta-icon" }), "copy");
    const text = line.createSpan();
    text.createSpan({ cls: "terminus-inbox-overlap-strong", text: fileCount(elsewhere.length) });
    text.createSpan({ text: ` this session edited ${elsewhere.length === 1 ? "is" : "are"} listed on ` });
    text.createSpan({ cls: "terminus-inbox-overlap-strong", text: `${owner}'s card` });
    text.createSpan({ text: `, because ${owner} changed ${elsewhere.length === 1 ? "it" : "them"} last. ` });
    const show = line.createEl("button", { cls: "terminus-inbox-overlap-show", text: "Show them" });
    show.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.ui.userAction();
      this.overlapOpen = true;
      this.render();
    });
  }

  private identify(card: InboxCard): { terminal: TerminalView | null; name: string; color: string | null } {
    const terminal = this.plugin.findTerminalView(card.token);
    const firstChange = card.changes[0];
    // panelLabel/panelColor are the FIRST contributor's, which is not this
    // card for a file another terminal started, so prefer the contributor
    // entry recorded for this card's own token.
    const own = card.changes.flatMap((c) => c.contributors).find((c) => c.token === card.token);
    return {
      terminal,
      name:
        terminal?.getDisplayText() ??
        own?.label ??
        firstChange?.panelLabel ??
        this.plugin.feedbackStore.listFor(card.token)[0]?.terminalLabel ??
        "Closed terminal",
      color: terminal ? terminal.effectiveColor : (own?.color ?? firstChange?.panelColor ?? null),
    };
  }

  private renderHeader(container: HTMLElement, needsCount: number, allChanges: PendingChange[]): void {
    const header = container.createDiv({ cls: "terminus-inbox-header" });
    header.createSpan({ cls: "terminus-inbox-title", text: "Agent inbox" });

    // Files more than one session wrote. `copy` rather than `users`: two
    // offset sheets, the same thing twice, with no person in it.
    const overlaps = allChanges.filter(hasCollision);
    if (overlaps.length > 0) {
      const chip = header.createEl("button", { cls: "terminus-inbox-overlap-chip" });
      setIcon(chip.createSpan({ cls: "terminus-meta-icon" }), "copy");
      chip.createSpan({ cls: "terminus-inbox-count", text: String(overlaps.length) });
      setTooltip(chip, `${fileCount(overlaps.length)} edited by more than one session`);
      chip.setAttr("aria-expanded", String(this.overlapOpen));
      chip.addEventListener("click", (evt) => {
        // Must not reach the document handler below: this re-renders
        // synchronously, so by the time the event finished bubbling the
        // chip it started on would be detached, the "was the click inside
        // the chip?" test would fail, and the popover would close again on
        // the very click that opened it.
        evt.stopPropagation();
        this.ui.userAction();
        this.overlapOpen = !this.overlapOpen;
        this.render();
      });
      if (this.overlapOpen) this.renderOverlapPopover(header, overlaps);
    } else {
      this.overlapOpen = false;
    }

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
    // A section owns its heading and its cards, so the pinned heading
    // leaves with the last of them instead of sitting over the next
    // section's.
    const section = body.createDiv({ cls: "terminus-inbox-section-group" });
    this.renderSectionHeading(section, label, cards.length, null);
    for (const card of cards) this.renderCard(section, card);
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
    // Everything identifying the session pins as one block: its name and
    // status, the meta line's counts, the banner asking for an answer and
    // the closing message. The work below it scrolls under all of that.
    const top = el.createDiv({ cls: "terminus-inbox-card-top" });
    const head = top.createDiv({ cls: "terminus-inbox-card-head" });
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

    const meta = top.createDiv({ cls: "terminus-inbox-card-meta" });
    const group = this.plugin.groupStore.get(terminal?.groupId);
    // A terminal and its group often share a name (both taken from Claude's
    // title); the group's then adds nothing but a repeat.
    if (group && group.name !== name) {
      const groupLabel = meta.createSpan({ cls: "terminus-inbox-group" });
      groupIcon(groupLabel, group.color);
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
    this.renderTurnSummary(meta, card);
    // A folded card has no agent rows, so its agents are counted in a line.
    const agents = collapsed ? summarizeAgents(session?.subagents ?? []) : null;
    if (agents) meta.createSpan({ cls: "terminus-inbox-agents-summary", text: agents });
    this.renderUsage(meta, sessionUsage(session), session?.usage ?? null);
    if (card.changes.length > 0) {
      const { added, removed } = sumStats(card.changes);
      // One unit, so a narrow card wraps before it rather than inside it.
      const pending = meta.createSpan({ cls: "terminus-inbox-pending" });
      pending.createSpan({ text: `${fileCount(card.changes.length)} to review` });
      pending.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
      pending.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
    }
    if (collapsed) return;

    if (needsAttention && session) {
      const banner = top.createDiv({ cls: "terminus-inbox-banner", attr: { role: "status" } });
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
        const quoteEl = top.createDiv({ cls: `terminus-inbox-quote${failed ? " is-failed" : ""}`, attr: { title: quote } });
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
    this.renderOwnedElsewhere(workEl, card, this.plugin.pendingChangesStore.list());
    // Changes from several requests waiting together is where "which of
    // these did I ask for?" gets hard, so each turn then gets a header with
    // the prompt that caused it. A single turn needs none: the card is it.
    if (card.turns.length > 1) {
      this.renderTurns(workEl, card);
      // Agents that changed nothing belong to no turn in particular, so
      // their rows stay on the card, below the turns.
      this.renderQuietAgents(workEl, card);
    } else if (card.subagents.length === 0) {
      this.renderTurnOverlapNote(workEl, card.token, card.changes);
      if (card.leadChanges.length > 0) this.renderChangeList(workEl.createDiv({ cls: "terminus-inbox-changes" }), card.leadChanges, card, null);
    } else {
      this.renderTurnOverlapNote(workEl, card.token, card.changes);
      this.renderAgents(workEl, card);
    }
    this.renderShellChanges(workEl, card);

    this.renderFeedback(workEl, card.token, name);
    this.renderDelegations(workEl, card.token, name);
    const composer = this.composerState(card);
    this.renderSteer(workEl, card, name, composer);
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
    if (composer === "closed") {
      const reply = foot.createEl("button", { cls: "terminus-btn-ghost terminus-inbox-reply" });
      setIcon(reply.createSpan({ cls: "terminus-meta-icon" }), "message-square");
      reply.createSpan({ text: "Reply" });
      setTooltip(reply, `Tell ${name}…`);
      reply.addEventListener("click", () => {
        this.ui.userAction();
        this.ui.openComposers.add(card.token);
        this.ui.focusComposer = card.token;
        this.render();
      });
    }
    if (terminal) {
      foot.createEl("button", { cls: "terminus-btn-ghost", text: "Open terminal" }).addEventListener("click", () =>
        void this.plugin.focusTerminal(card.token)
      );
    }
  }

  /**
   * Whether a card's "Tell this session…" box is shown:
   * - `none`: no live session or terminal to tell (the card has ended).
   * - `hidden`: Claude waits on a prompt, where typed text could answer it;
   *   the banner's "Answer in terminal" is the action. Queued messages and a
   *   draft are kept.
   * - `open`: Claude is working, or Reply opened the box, or it holds a draft.
   * - `closed`: between turns with nothing typed; the footer offers Reply.
   */
  private composerState(card: InboxCard): "none" | "hidden" | "open" | "closed" {
    const token = card.token;
    const session = this.plugin.agentSessionStore.get(token);
    if (card.ended || !session?.running || !this.plugin.findTerminalView(token)) return "none";
    if (!this.plugin.steerReadiness(token).ready) return "hidden";
    if (session.status === "working" || this.ui.openComposers.has(token) || this.ui.drafts.has(token)) return "open";
    return "closed";
  }

  /**
   * "Tell this session…": a box on a running session's card, with the
   * session's queued messages above it. Three ways to deliver:
   * - "Add to input" types the text into the session's input line for the
   *   user to send.
   * - "Steer" types it and presses Enter. Claude queues text entered mid-turn
   *   and folds it into the running turn, so this works while it works.
   * - "Queue" holds it here until the turn ends (see queueGuidance).
   * Cmd/Ctrl+Enter does the default one (settings), Cmd/Ctrl+Shift+Enter the
   * other. The draft is kept in the plugin's inbox state, so folding the card
   * or re-rendering doesn't lose it.
   */
  private renderSteer(el: HTMLElement, card: InboxCard, name: string, state: "none" | "hidden" | "open" | "closed"): void {
    const token = card.token;
    if (state === "none") return;
    const readiness = this.plugin.steerReadiness(token);
    const defaultBehavior = this.plugin.settings.multiAgent.sendBehavior;
    const section = el.createDiv({ cls: "terminus-inbox-steer" });
    this.renderQueue(section, token);
    if (state !== "open") {
      if (!section.hasChildNodes()) section.remove();
      return;
    }

    const mod = Platform.isMacOS ? "⌘" : "Ctrl";
    const input = section.createEl("textarea", {
      cls: "terminus-inbox-steer-input",
      attr: { rows: "2", placeholder: `Tell ${name}…  (${mod}↵ ${defaultBehavior}s · ${mod}⇧↵ ${defaultBehavior === "steer" ? "queues" : "steers"})` },
    });
    input.value = this.ui.drafts.get(token) ?? "";
    input.addEventListener("input", () => {
      if (input.value) this.ui.drafts.set(token, input.value);
      else this.ui.drafts.delete(token);
    });
    // Leaving an empty box that Reply opened puts it away again; a click on
    // its own buttons is not leaving it. Deferred a tick so a blur() call
    // can't have its render skipped (see renderNow).
    input.addEventListener("blur", (evt) => {
      const to = evt.relatedTarget;
      window.setTimeout(() => {
        this.renderIfSkipped();
        if (to instanceof Node && section.contains(to)) return;
        if (this.plugin.agentSessionStore.get(token)?.status === "working" || this.ui.drafts.has(token) || !this.ui.openComposers.delete(token)) return;
        this.render();
      }, 0);
    });
    if (this.ui.focusComposer === token) {
      this.ui.focusComposer = null;
      input.focus();
    }

    const actions = section.createDiv({ cls: "terminus-inbox-steer-actions" });
    const add = actions.createEl("button", { cls: "terminus-btn-ghost", text: "Add to input" });
    setTooltip(add, "Types it into the session's input line and takes you to the terminal; you press Enter");
    const buttons = {
      queue: actions.createEl("button", { text: "Queue" }),
      steer: actions.createEl("button", { text: "Steer" }),
    };
    setTooltip(buttons.queue, "Holds it until this turn ends, then sends it (one queued message per turn)");
    setTooltip(buttons.steer, "Types it into the session's input line and presses Enter: Claude folds it into the turn it's working on");
    for (const behavior of ["queue", "steer"] as const) {
      buttons[behavior].addClass(behavior === defaultBehavior ? "terminus-btn-ghost-accent" : "terminus-btn-ghost");
    }
    if (!readiness.ready) {
      add.disabled = true;
      buttons.steer.disabled = true;
      actions.createSpan({ cls: "terminus-inbox-foot-note", text: readiness.reason });
    }
    const deliver = async (mode: "add" | "steer" | "queue") => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      const sent = mode === "queue" ? this.plugin.queueGuidance(token, text) : await this.plugin.sendGuidance(token, text, mode === "steer");
      if (!sent) return;
      this.ui.drafts.delete(token);
      this.ui.openComposers.delete(token);
      input.value = "";
      input.blur();
      this.render();
    };
    add.addEventListener("click", () => void deliver("add"));
    buttons.queue.addEventListener("click", () => void deliver("queue"));
    buttons.steer.addEventListener("click", () => void deliver("steer"));
    input.addEventListener("keydown", (evt) => {
      if (evt.key !== "Enter" || !(evt.metaKey || evt.ctrlKey)) return;
      evt.preventDefault();
      const opposite = defaultBehavior === "steer" ? "queue" : "steer";
      const mode = evt.shiftKey ? opposite : defaultBehavior;
      if (mode === "steer" && !readiness.ready) return;
      void deliver(mode);
    });
  }

  /** A render that was skipped while a box had focus runs once it's left. */
  private renderIfSkipped(): void {
    if (!this.renderSkipped) return;
    this.renderSkipped = false;
    this.render();
  }

  /**
   * A session's queued messages, in the order they'll be sent: drag to
   * reorder, edit in place, Steer to send one into the running turn now, or
   * remove. They go out one per turn end unless something holds the queue
   * (a prompt open, a failed turn, a restart), which the header says.
   */
  private renderQueue(el: HTMLElement, token: string): void {
    const items = this.plugin.steerQueue.listFor(token);
    if (items.length === 0) return;
    const queue = el.createDiv({ cls: "terminus-inbox-queue" });
    const head = queue.createDiv({ cls: "terminus-inbox-queue-head" });
    iconLabel(head, "list-ordered", `Queued ${items.length}`, "terminus-inbox-queue-title");
    const hold = this.plugin.queueHoldReason(token);
    if (hold) head.createSpan({ cls: "terminus-inbox-foot-note", text: hold });
    head.createDiv({ cls: "terminus-inbox-spacer" });
    if (this.plugin.steerQueue.isPaused(token)) {
      const resume = head.createEl("button", { cls: "terminus-btn-ghost-accent", text: "Resume" });
      setTooltip(resume, "Send the queue from here: the next message goes out when the session is between turns");
      resume.addEventListener("click", () => this.plugin.steerQueue.resume(token));
    }
    const clear = head.createEl("button", { cls: "terminus-btn-ghost", text: "Clear" });
    setTooltip(clear, "Remove every queued message for this session");
    clear.addEventListener("click", () => this.plugin.steerQueue.clear(token));

    const steerReady = this.plugin.steerReadiness(token).ready;
    let dragId: number | null = null;
    const clearDropMarks = () => queue.querySelectorAll(".is-drop-before, .is-drop-after").forEach((row) => row.removeClasses(["is-drop-before", "is-drop-after"]));
    items.forEach((item, index) => {
      const row = queue.createDiv({ cls: "terminus-inbox-queue-item", attr: { draggable: "true" } });
      const grip = row.createSpan({ cls: "terminus-inbox-queue-grip" });
      setIcon(grip, "grip-vertical");
      setTooltip(grip, "Drag to reorder");
      if (this.editingQueueId === item.id) {
        this.renderQueueEditor(row, token, item.id, item.text);
        row.draggable = false;
        return;
      }
      row.createSpan({ cls: "terminus-inbox-queue-text", text: item.text, attr: { title: item.text } });
      iconButton(row, "pencil", "Edit this message", () => {
        this.editingQueueId = item.id;
        this.render();
      });
      const steer = row.createEl("button", { cls: "terminus-btn-ghost terminus-inbox-queue-steer" });
      setIcon(steer.createSpan({ cls: "terminus-meta-icon" }), "corner-up-right");
      steer.createSpan({ text: "Steer" });
      if (steerReady) {
        setTooltip(steer, "Send this into the running turn now, ahead of the rest of the queue");
        steer.addEventListener("click", () => void this.plugin.steerQueued(token, item.id));
      } else {
        steer.disabled = true;
      }
      iconButton(row, "x", "Remove this message", () => this.plugin.steerQueue.remove(token, item.id));

      row.addEventListener("dragstart", (evt) => {
        dragId = item.id;
        evt.dataTransfer?.setData("text/plain", item.text);
        if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
        row.addClass("is-dragging");
      });
      row.addEventListener("dragend", () => {
        dragId = null;
        row.removeClass("is-dragging");
        clearDropMarks();
      });
      row.addEventListener("dragover", (evt) => {
        if (dragId === null || dragId === item.id) return;
        evt.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = evt.clientY > rect.top + rect.height / 2;
        clearDropMarks();
        row.addClass(after ? "is-drop-after" : "is-drop-before");
      });
      row.addEventListener("drop", (evt) => {
        if (dragId === null) return;
        evt.preventDefault();
        const rect = row.getBoundingClientRect();
        const after = evt.clientY > rect.top + rect.height / 2;
        const before = after ? (items[index + 1]?.id ?? null) : item.id;
        const moving = dragId;
        dragId = null;
        clearDropMarks();
        this.plugin.steerQueue.move(token, moving, before);
      });
    });
  }

  /** The in-place editor for one queued message: Enter saves, Escape
   *  cancels, leaving the box saves. Emptying it removes the message. */
  private renderQueueEditor(row: HTMLElement, token: string, id: number, text: string): void {
    const box = row.createEl("textarea", { cls: "terminus-inbox-steer-input terminus-inbox-queue-editor", attr: { rows: "2" } });
    box.value = text;
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.editingQueueId = null;
      if (save) this.plugin.steerQueue.edit(token, id, box.value);
      // A focused box holds a render back, and an unchanged save emits none.
      box.blur();
      this.render();
    };
    box.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        evt.preventDefault();
        finish(false);
      } else if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        finish(true);
      }
    });
    box.addEventListener("blur", () => finish(true));
    window.setTimeout(() => {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }, 0);
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

  /** Model, tokens, context % and ≈ cost. `usage` is what's counted (a card's lead
   *  plus its subagents); `contextOf` is the one conversation whose context
   *  fill is shown. Nothing renders without usage, e.g. when Claude Code
   *  isn't saving transcripts. */
  private renderUsage(parent: HTMLElement, usage: UsageTotals | null, contextOf: UsageTotals | null): void {
    if (!usage) return;
    // The conversation's own model, like its context fill: a card shows the
    // lead's, each agent row its own.
    if (contextOf?.model) parent.createSpan({ text: formatModelName(contextOf.model), attr: { title: contextOf.model } });
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
    const withChanges = card.subagents.filter((sub) => sub.changes.length > 0);
    const busy = card.subagents.filter((sub) => sub.changes.length === 0 && needsOwnRow(sub));

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
    this.renderQuietFold(el, card);
  }

  /**
   * The agent rows that belong to the card rather than to any one turn: a
   * subagent still running or failed with nothing to review yet, then the
   * fold of finished ones that changed nothing. Only the turn-grouped
   * layout calls this, since there every agent WITH changes is already
   * listed under the turn that asked for them.
   */
  private renderQuietAgents(el: HTMLElement, card: InboxCard): void {
    for (const sub of card.subagents.filter((sub) => sub.changes.length === 0 && needsOwnRow(sub))) {
      this.renderSubagent(el, card, sub, false);
    }
    this.renderQuietFold(el, card);
  }

  /** "3 agents with nothing to review", foldable; nothing when there are
   *  none. Shared by both layouts. */
  private renderQuietFold(el: HTMLElement, card: InboxCard): void {
    const quiet = card.subagents.filter((sub) => !needsOwnRow(sub));
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
    for (const sub of quiet) void this.renderSubagent(fold, card, sub, true);
    if (card.hiddenSubagents > 0) {
      fold.createDiv({ cls: "terminus-inbox-more", text: `and ${card.hiddenSubagents} earlier` });
    }
  }

  private renderSubagent(el: HTMLElement, card: InboxCard, sub: InboxSubagent, compact: boolean, scope = "", underTurn = false): string[] {
    const running = sub.run?.running ?? false;
    const details: string[] = [];
    const time = subagentTime(sub.run);
    if (time) details.push(time);
    const failed = sub.run?.outcome === "failed" && sub.run.error ? sub.run.error : null;
    // Named by its task ("Division note long form"), which is what tells
    // one agent from another; the type ("general-purpose") is secondary.
    const task = sub.run?.description ?? null;
    return this.renderAgent(el, card, {
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
      scope,
      underTurn,
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
      /** Distinguishes this row's change list from the same agent's list
       *  under another turn, so their folder folds don't share a key. */
      scope?: string;
      /** A turn header sits above this row and owns the fold-all control,
       *  so the change list below skips its own header. */
      underTurn?: boolean;
    }
  ): string[] {
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

    if (agent.changes.length === 0) return [];
    return this.renderChangeList(
      row.createDiv({ cls: "terminus-inbox-agent-changes" }),
      agent.changes,
      card,
      agent.agentId,
      agent.scope ?? "",
      agent.underTurn === true
    );
  }

  /**
   * "3 turns · 12m 4s": how many requests this session has had, and how long
   * it has actually spent working on them -- its turns added up (see
   * activeTime), not the wall clock, which on a session left open counts
   * every gap where it sat waiting for the user. A running turn keeps the
   * total ticking. Per-turn durations aren't here: with the turns listed,
   * one figure for the session is what the card has room to say.
   */
  private renderTurnSummary(meta: HTMLElement, card: InboxCard): void {
    const session = card.session;
    // No turns on record: a session that was already running before this
    // version, or Classic's hooks, which carry no prompt_id to key turns by.
    // The last turn's own duration is then all there is to show.
    if (!session || session.turns.length === 0) {
      if (session?.lastTurnMs != null && session.status !== "working") {
        meta.createSpan({ text: `turn ${formatDuration(session.lastTurnMs)}` });
      } else if (!card.ended && session?.status === "working" && session.turnStartedAt !== null) {
        liveElapsed(meta, session.turnStartedAt, "turn so far");
      }
      return;
    }
    const count = session.turns.length;
    const { finishedMs, runningSince } = activeTime(session);
    const running = runningSince !== null && !card.ended;
    const summary = meta.createSpan({ cls: "terminus-inbox-turns-summary" });
    summary.createSpan({ text: `${count} ${count === 1 ? "turn" : "turns"}` });
    if (running && runningSince !== null) liveElapsed(summary, runningSince, "", finishedMs);
    else if (finishedMs > 0) summary.createSpan({ text: formatDuration(finishedMs) });
    const total = finishedMs + (running && runningSince !== null ? Date.now() - runningSince : 0);
    setTooltip(
      summary,
      `${count} ${count === 1 ? "request" : "requests"} this session, ${formatDuration(total)} spent working.\nTime between turns, while Claude waited on you, isn't counted.`
    );
  }

  /**
   * The card's changes under one header per turn, oldest first, each header
   * carrying the prompt that caused them (see inboxModel's buildTurns). This
   * is what turns "7 files to review" into "this request changed 4 and that
   * one changed 3", which is the difference between reviewing a pile and
   * reviewing a request.
   */
  private renderTurns(el: HTMLElement, card: InboxCard): void {
    const section = el.createDiv({ cls: "terminus-inbox-turns" });
    card.turns.forEach((turn, index) => {
      const scope = turn.promptId ?? "unattributed";
      const key = `${card.token}|${scope}`;
      const folded = this.ui.collapsedTurns.has(key);
      // Each turn is its own box, so its header sticks only while that
      // turn's own files are on screen and releases as the next one
      // arrives. Siblings in one container would all pin at the same
      // offset and stack invisibly on top of each other.
      const turnEl = section.createDiv({ cls: "terminus-inbox-turn" });
      const head = turnEl.createDiv({ cls: "terminus-inbox-turn-head" });
      head.toggleClass("is-failed", turn.record?.failed === true);
      setIcon(head.createSpan({ cls: "terminus-inbox-chevron" }), folded ? "chevron-right" : "chevron-down");
      head.createSpan({ cls: "terminus-inbox-turn-index", text: String(index + 1) });
      const label = turnLabel(turn);
      // The header shows one line; hovering gives the whole prompt. Obsidian's
      // own tooltip rather than a title attribute: it appears at once, wraps
      // over as many lines as the prompt needs and follows the theme, where
      // the native one waits about a second and renders as one OS-styled
      // strip. Deliberately no `classes` option -- that is Obsidian 1.8.7+
      // and this plugin supports 1.7.2.
      const promptEl = head.createSpan({ cls: "terminus-inbox-turn-prompt", text: label });
      setTooltip(promptEl, turn.prompt ?? label, { placement: "top" });
      const { added, removed } = sumStats(turn.changes);
      // Filled in below, once the body says whether anything grouped by
      // folder. The turn header is the only place these totals appear, so
      // the fold-all control comes up here to join them rather than riding
      // on a second header that repeats them. It sits left of the totals so
      // the numbers stay the rightmost thing on every row, at every depth.
      const foldSlot = head.createSpan({ cls: "terminus-inbox-fold-slot" });
      const stats = head.createSpan({ cls: "terminus-inbox-turn-stats" });
      stats.createSpan({ text: fileCount(turn.changes.length) });
      stats.createSpan({ cls: "terminus-diff-stat-add", text: `+${added}` });
      stats.createSpan({ cls: "terminus-diff-stat-remove", text: `-${removed}` });
      const toggle = () => {
        this.ui.userAction();
        if (folded) this.ui.collapsedTurns.delete(key);
        else this.ui.collapsedTurns.add(key);
        this.render();
      };
      head.addEventListener("click", toggle);
      makeActivatable(head, toggle, () => undefined);
      head.setAttr("aria-expanded", String(!folded));
      // Under the header, not inside the body: it summarises the turn, so
      // it should still be readable while the turn is folded shut.
      this.renderTurnOverlapNote(turnEl, card.token, turn.changes);
      if (folded) return;

      const body = turnEl.createDiv({ cls: "terminus-inbox-turn-body" });
      // Every folder key under this turn, so one control folds them all.
      const keys: string[] = [];
      const done = () => {
        if (keys.length > 0) this.renderFoldAll(foldSlot, keys);
      };
      // A turn with no subagent of its own doesn't need a "Lead" row to
      // hang its files off: everything in it is the lead's.
      if (turn.subagents.length === 0) {
        keys.push(...this.renderChangeList(body.createDiv({ cls: "terminus-inbox-changes" }), turn.leadChanges, card, null, scope, true));
        done();
        return;
      }
      if (turn.leadChanges.length > 0) {
        keys.push(...this.renderAgent(body, card, {
          agentId: null,
          mark: { kind: "lead", icon: "bot", label: "Lead session" },
          name: "Lead",
          secondary: "main session",
          details: [],
          changes: turn.leadChanges,
          scope,
          underTurn: true,
        }));
      }
      for (const sub of turn.subagents) keys.push(...this.renderSubagent(body, card, sub, false, scope, true));
      done();
    });
  }

  /** One control for every folder under a turn. Lives on the turn header,
   *  which already carries that turn's totals. */
  private renderFoldAll(host: HTMLElement, keys: string[]): void {
    const allFolded = keys.every((key) => this.ui.collapsedFolders.has(key));
    iconButton(host, allFolded ? "chevrons-up-down" : "chevrons-down-up", allFolded ? "Expand all folders" : "Collapse all folders", () => {
      this.ui.userAction();
      for (const key of keys) {
        if (allFolded) this.ui.collapsedFolders.delete(key);
        else this.ui.collapsedFolders.add(key);
      }
      this.render();
    });
  }

  /**
   * Files that changed in the session's folder with no edit hook to account
   * for them -- Claude working through the shell (see git/gitStatus.ts).
   * Listed only: there's no pre-edit snapshot of these, so there's no diff
   * to show and no Reject that could revert them, and claiming otherwise
   * would be worse than saying nothing. What this buys is that an empty
   * review list stops meaning "nothing happened".
   */
  private renderShellChanges(el: HTMLElement, card: InboxCard): void {
    // With detection off nothing refreshes this list, so whatever it last
    // held would sit on the card indefinitely claiming to describe the
    // session.
    if (!this.plugin.settings.detectShellChanges) return;
    const changes = card.session?.shellChanges ?? [];
    if (changes.length === 0) return;
    const expanded = this.ui.expandedShellChanges.has(card.token);
    const section = el.createDiv({ cls: "terminus-inbox-shell" });
    const head = section.createDiv({ cls: "terminus-inbox-shell-head" });
    setIcon(head.createSpan({ cls: "terminus-inbox-chevron" }), expanded ? "chevron-down" : "chevron-right");
    setIcon(head.createSpan({ cls: "terminus-meta-icon" }), "terminal");
    head.createSpan({ text: `${fileCount(changes.length)} changed without a snapshot` });
    setTooltip(head, SHELL_CHANGE_TOOLTIP);
    const toggle = () => {
      this.ui.userAction();
      if (expanded) this.ui.expandedShellChanges.delete(card.token);
      else this.ui.expandedShellChanges.add(card.token);
      this.render();
    };
    head.addEventListener("click", toggle);
    makeActivatable(head, toggle, () => undefined);
    head.setAttr("aria-expanded", String(expanded));
    if (!expanded) return;

    renderShellChangeRows(this.rows, section, changes);
  }

  /** `owner` is the agent the rows sit under (null: the lead); a file that
   *  other agents in this session also edited says which. A long list over
   *  several folders is grouped by folder, each foldable. */
  private renderChangeList(
    parent: HTMLElement,
    changes: PendingChange[],
    card: InboxCard,
    owner: string | null,
    scope = "",
    /** A turn header above already shows these totals and hosts the
     *  fold-all control, so no header is drawn here. */
    underTurn = false
  ): string[] {
    if (changes.length === 0) return [];
    const list = parent.createDiv({ cls: "terminus-pending-list" });
    const row = (target: HTMLElement, change: PendingChange, hideFolder: boolean) => {
      const others = change.agents.filter((a) => a.token === card.token && a.agentId !== owner).map((a) => agentLabel(card, a.agentId, a.agentType));
      renderChangeRow(this.rows, target, change, computeDiffStats(change.diff), { alsoEditedBy: others, hideFolder });
    };
    const folders = changes.length >= TREE_MIN_FILES ? this.groupByFolder(changes) : null;
    if (!folders || folders.length < 2) {
      for (const change of changes) row(list, change, false);
      return [];
    }

    const keyOf = (folder: string) => `${card.token}|${scope}|${owner ?? ""}|${folder}`;
    const keys = folders.map((f) => keyOf(f.folder));
    // Without a turn above, nothing else here counts the folders or offers
    // to fold them, so this list says so itself -- but it still leaves the
    // +/- totals to the one place that already has them (the card's meta
    // line, or the turn header), rather than printing them twice.
    if (!underTurn) {
      const head = list.createDiv({ cls: "terminus-inbox-tree-head" });
      head.createSpan({ text: `${folders.length} folders` });
      head.createDiv({ cls: "terminus-inbox-spacer" });
      this.renderFoldAll(head, keys);
    }

    for (const { folder, changes: inFolder } of folders) {
      const key = keyOf(folder);
      const folded = this.ui.collapsedFolders.has(key);
      // Its own box, as the turn has, so the heading stops sticking when
      // its folder ends rather than riding over the next one.
      const group = list.createDiv({ cls: "terminus-inbox-folder-group" });
      const heading = group.createDiv({ cls: "terminus-inbox-folder" });
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
      if (!folded) for (const change of inFolder) row(group, change, true);
    }
    return keys;
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

/** The four levels that pin, outermost first: section, session, turn,
 *  folder. Each parks under the one above it. */
const STICKY_HEADS = ".terminus-inbox-section, .terminus-inbox-card-top, .terminus-inbox-turn-head, .terminus-inbox-folder";

/** The nearest ancestor background that actually paints something. Falls
 *  back to the sidebar surface, which is where this view lives. */
function opaqueBackground(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const colour = window.getComputedStyle(node).backgroundColor;
    if (colour && colour !== "transparent" && !colour.startsWith("rgba(0, 0, 0, 0)")) return colour;
  }
  return "var(--background-secondary)";
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

/** "running 2m 14s", counting up on its own (see tickElapsed). `base` is
 *  added to the elapsed time, for a running total that already has finished
 *  turns in it; `label` can be empty where the surrounding text says it. */
function liveElapsed(parent: HTMLElement, since: number, label: string, base = 0): void {
  const el = parent.createSpan();
  if (label) el.appendText(`${label} `);
  el.createSpan({
    cls: "terminus-inbox-live-elapsed",
    text: formatDuration(base + Date.now() - since),
    attr: { "data-since": String(since), "data-base": String(base) },
  });
}

/** A subagent row that has to show on its own: it changed something, it's
 *  still running, or it failed. The rest fold into "nothing to review". */
function needsOwnRow(sub: InboxSubagent): boolean {
  return sub.changes.length > 0 || sub.run?.running === true || sub.run?.outcome === "failed";
}

/** A turn's header text: the prompt it opened with, in one line. */
function turnLabel(turn: InboxTurn): string {
  const prompt = turn.prompt ? plainPreview(turn.prompt) : "";
  if (prompt) return prompt;
  // A turn Terminus saw only through its edits: Classic installs no
  // UserPromptSubmit hook, and in Multi-agent they can go in mid-turn.
  return turn.promptId ? "Request not recorded" : "Not tied to a request";
}

function fileCount(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
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
