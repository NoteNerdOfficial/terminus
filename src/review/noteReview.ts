import { MarkdownView, Notice, type Editor } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { pathBasename, pathJoin } from "terminus-node-bridge";
import type TerminusPlugin from "../main";
import { composeFeedbackPrompt } from "../claude/feedbackPrompt";
import type { FeedbackItem, NewFeedbackItem } from "../state/FeedbackStore";
import type { ReviewIntent } from "../browser/review";
import { bindTextKeys, renderComposerFields, renderShortcutHint } from "./composer";

const CARD_WIDTH = 340;
/** The "To" menu's value for a new Claude session. */
const NEW_SESSION = "\u0000new";

/** What each type means for text in a note (the browser's words are about a page). */
export const NOTE_HINTS: Record<ReviewIntent, string> = {
  change: "Ask Claude to change this text. It edits the note, then you check the result.",
  question: "Ask about this text without asking for a change. Claude answers and leaves the note as it is.",
  keep: "Mark this text as right as it is. Claude won't change it while it works on your other comments.",
};
const MAX_EXCERPT_SHOWN = 140;

interface Selection {
  /** The note, absolute, as the other review comments name files. */
  filePath: string;
  /** As the user sees it: vault-relative. */
  shownPath: string;
  lines: { start: number; end: number };
  text: string;
}

/**
 * Review for text selected in a markdown note: the same Change / Question /
 * Keep box as the browser's review mode (see composer.ts), opened from the
 * editor's right-click menu or the "Review selection" command.
 *
 * A comment joins the comments on Claude's edits: queued on a session's card
 * in the Agent inbox (Add), to be sent with the rest, or sent to it straight
 * away (Send now). Multi-agent only, because that queue is.
 */
export class NoteReview {
  private card: HTMLElement | null = null;

  constructor(private readonly plugin: TerminusPlugin) {}

  /** Called once from onload. */
  register(): void {
    const { plugin } = this;
    plugin.registerEvent(
      plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
        if (!this.available() || !(info instanceof MarkdownView) || !editor.somethingSelected()) return;
        menu.addItem((item) =>
          item
            .setTitle("Review with Terminus…")
            .setIcon("message-square-plus")
            .setSection("selection")
            .onClick(() => this.open(editor, info))
        );
      })
    );
    plugin.addCommand({
      id: "review-selection",
      name: "Review selection",
      editorCheckCallback: (checking, editor, ctx) => {
        if (!this.available() || !(ctx instanceof MarkdownView) || !editor.somethingSelected()) return false;
        if (!checking) this.open(editor, ctx);
        return true;
      },
    });
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => this.close()));
  }

  close(): void {
    this.card?.remove();
    this.card = null;
  }

  private available(): boolean {
    return this.plugin.experience === "multi-agent";
  }

  private open(editor: Editor, view: MarkdownView): void {
    const selection = this.readSelection(editor, view);
    if (!selection) return;
    this.close();
    const doc = view.containerEl.doc;
    const card = doc.body.createDiv({ cls: ["terminus-review-composer", "terminus-note-review"], attr: { role: "dialog", "aria-label": "Review selection" } });
    this.card = card;

    const head = card.createDiv({ cls: "terminus-review-composer-head" });
    const span = selection.lines.start === selection.lines.end ? `line ${selection.lines.start}` : `lines ${selection.lines.start}–${selection.lines.end}`;
    head.createSpan({ cls: "terminus-review-element", text: `${selection.shownPath} · ${span}` });
    const flat = selection.text.replace(/\s+/g, " ").trim();
    card.createDiv({
      cls: "terminus-note-review-quote",
      text: flat.length > MAX_EXCERPT_SHOWN ? `${flat.slice(0, MAX_EXCERPT_SHOWN - 1)}…` : flat,
    });

    const fields = renderComposerFields(card, "change", NOTE_HINTS);

    // Which Claude session it goes to: a running one, or a new one (the
    // only choice when none is running).
    const targets = this.targets(selection.filePath);
    const to = card.createDiv({ cls: "terminus-note-review-to" });
    to.createSpan({ cls: "terminus-note-review-to-label", text: "To" });
    const select = to.createEl("select", { cls: "dropdown", attr: { "aria-label": "Claude session" } });
    for (const target of targets) select.createEl("option", { text: target.label, value: target.token });
    select.createEl("option", { text: "New Claude session", value: NEW_SESSION });
    select.value = targets[0]?.token ?? NEW_SESSION;
    let token: string | null = targets[0]?.token ?? null;

    const actions = card.createDiv({ cls: "terminus-review-composer-actions" });
    const setShortcut = renderShortcutHint(actions);
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    const sendNow = actions.createEl("button", { text: "Send now", attr: { type: "button" } });
    const add = actions.createEl("button", { cls: "mod-cta", text: "Add", attr: { type: "button" } });
    const start = actions.createEl("button", { cls: "mod-cta", text: "Start session", attr: { type: "button" } });
    sendNow.setAttr("title", "Send this comment on its own, as soon as the session is between turns");
    add.setAttr("title", "Queue it on the session's card in the Agent inbox, to send with your other comments");
    start.setAttr("title", "Open a new terminal running Claude, with this comment typed in for you to send");
    // A new session has no queue to add to: one button starts it instead.
    const showButtons = (): void => {
      const fresh = token === null;
      sendNow.toggle(!fresh);
      add.toggle(!fresh);
      start.toggle(fresh);
      setShortcut(fresh ? "start" : "add");
    };
    select.addEventListener("change", () => {
      token = select.value === NEW_SESSION ? null : select.value;
      showButtons();
    });
    showButtons();

    const item = (): NewFeedbackItem | null => {
      const text = fields.text();
      if (text === null || token === null) {
        fields.textarea.focus();
        return null;
      }
      return {
        token,
        terminalLabel: this.plugin.findTerminalView(token)?.getDisplayText() ?? "Claude",
        filePath: selection.filePath,
        oldLines: null,
        newLines: selection.lines,
        excerpt: selection.text,
        comment: text,
        rejected: false,
        intent: fields.intent(),
      };
    };
    // A Keep is also remembered on its own: marked in the note and checked
    // against Claude's edits, however the comment itself goes.
    const keep = (next: NewFeedbackItem): void => {
      if (next.intent !== "keep") return;
      this.plugin.noteKeeps.add({ filePath: selection.filePath, text: selection.text, line: selection.lines.start, reason: next.comment });
    };
    const queue = (): void => {
      const next = item();
      if (!next) return;
      keep(next);
      this.plugin.feedbackStore.add(next);
      new Notice(`Terminus: queued for ${next.terminalLabel} in the Agent inbox`);
      this.close();
    };
    const send = (): void => {
      const next = item();
      if (!next) return;
      const prompt = composeFeedbackPrompt([{ ...next, id: 0, createdAt: Date.now() }], () => selection.shownPath);
      if (!this.plugin.queueGuidance(next.token, prompt)) {
        new Notice(`Terminus: couldn't send to ${next.terminalLabel}: its Claude session isn't running`);
        return;
      }
      keep(next);
      const busy = this.plugin.agentSessionStore.get(next.token)?.status === "working";
      new Notice(busy ? `Terminus: queued for ${next.terminalLabel}; it gets it when its turn ends` : `Terminus: sent to ${next.terminalLabel}`);
      this.close();
    };
    const startNew = (): void => {
      const text = fields.text();
      if (text === null) {
        fields.textarea.focus();
        return;
      }
      const intent = fields.intent();
      const draft: FeedbackItem = {
        id: 0,
        createdAt: Date.now(),
        token: "",
        terminalLabel: "",
        filePath: selection.filePath,
        oldLines: null,
        newLines: selection.lines,
        excerpt: selection.text,
        comment: text,
        rejected: false,
        intent,
      };
      if (intent === "keep") this.plugin.noteKeeps.add({ filePath: selection.filePath, text: selection.text, line: selection.lines.start, reason: text });
      const prompt = composeFeedbackPrompt([draft], () => selection.shownPath);
      this.close();
      void this.plugin.startClaudeWith(prompt, `Review · ${pathBasename(selection.shownPath)}`).then((terminal) => {
        new Notice(terminal ? `Terminus: started ${terminal.getDisplayText()} with your comment typed in. Press Enter to send it.` : "Terminus: couldn't open a new terminal");
      });
    };
    cancel.addEventListener("click", () => this.close());
    sendNow.addEventListener("click", send);
    add.addEventListener("click", queue);
    start.addEventListener("click", startNew);
    bindTextKeys(fields.textarea, () => (token === null ? startNew() : queue()), () => this.close());

    this.place(card, editor, view);
    window.setTimeout(() => fields.textarea.focus(), 0);
  }

  private readSelection(editor: Editor, view: MarkdownView): Selection | null {
    const file = view.file;
    const text = editor.getSelection();
    if (!file || !text.trim()) return null;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    // A selection that ends at the very start of a line doesn't include it.
    const endLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    return {
      filePath: pathJoin(this.plugin.getVaultBasePath(), file.path),
      shownPath: file.path,
      lines: { start: from.line + 1, end: endLine + 1 },
      text,
    };
  }

  /**
   * Running Claude sessions, the likeliest first: one with an edit to this
   * note waiting for review (the last to edit it first), then the rest by
   * when their last turn ended.
   */
  private targets(filePath: string): { token: string; label: string }[] {
    const { plugin } = this;
    const running = plugin.groups.terminals().filter((terminal) => plugin.agentSessionStore.get(terminal.hookToken)?.running);
    const change = plugin.pendingChangesStore.list().find((pending) => pending.diff.filePath === filePath);
    const editors = (change?.contributors ?? []).map((contributor) => contributor.token).reverse();
    const rank = (token: string): number => {
      const i = editors.indexOf(token);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const ended = (token: string): number => plugin.agentSessionStore.get(token)?.lastTurnEndedAt ?? 0;
    return running
      .sort((a, b) => rank(a.hookToken) - rank(b.hookToken) || ended(b.hookToken) - ended(a.hookToken))
      .map((terminal) => ({ token: terminal.hookToken, label: terminal.getDisplayText() }));
  }

  /** Just below the end of the selection, or above it when there's no room. */
  private place(card: HTMLElement, editor: Editor, view: MarkdownView): void {
    const win = view.containerEl.win;
    const cm = (editor as Editor & { cm?: EditorView }).cm;
    const coords = cm?.coordsAtPos(editor.posToOffset(editor.getCursor("to"))) ?? null;
    const box = view.contentEl.getBoundingClientRect();
    const width = Math.min(CARD_WIDTH, win.innerWidth - 16);
    card.style.width = `${width}px`;
    const height = card.offsetHeight || 260;
    let left = coords ? coords.left - 16 : box.left + (box.width - width) / 2;
    let top = coords ? coords.bottom + 8 : box.top + 40;
    if (coords && top + height > win.innerHeight - 8) top = coords.top - height - 8;
    left = Math.max(8, Math.min(left, win.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, win.innerHeight - height - 8));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }
}
