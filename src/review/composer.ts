import { Platform, setIcon, setTooltip } from "obsidian";
import { INTENT_HINTS, INTENT_LABELS, type ReviewIntent } from "../browser/review";

/**
 * The comment box shared by every review surface (the browser's review
 * mode, and a selection in a markdown note): the Change / Question / Keep
 * toggle with a line saying what the chosen type does, the text box, and
 * the ⌘/Ctrl+Enter and Escape keys. Each surface adds its own heading and
 * buttons around it.
 */

export const INTENTS: ReviewIntent[] = ["change", "question", "keep"];

export const INTENT_ICONS: Record<ReviewIntent, string> = {
  change: "pencil",
  question: "help-circle",
  keep: "lock",
};

export const INTENT_PLACEHOLDERS: Record<ReviewIntent, string> = {
  change: "What should change here?",
  question: "What do you want to know?",
  keep: "Why it should stay as it is (optional)",
};

export interface ComposerFields {
  textarea: HTMLTextAreaElement;
  /** The type chosen now. */
  intent(): ReviewIntent;
  /** The text, trimmed, or null when the type needs words and has none
   *  (a Keep needs none: picking it is the whole message). */
  text(): string | null;
}

/**
 * The type toggle, its meaning line and the text box, appended to `card`.
 * The toggle is a radio group drawn as a segmented control: one tab stop,
 * arrow keys move between types, and a filled pill slides to the one chosen.
 */
export function renderComposerFields(
  card: HTMLElement,
  initial: ReviewIntent = "change",
  /** What each type means here, if not the browser's words (a page). */
  hints: Record<ReviewIntent, string> = INTENT_HINTS
): ComposerFields {
  let intent: ReviewIntent = initial;
  const chips = card.createDiv({ cls: "terminus-review-intents", attr: { role: "radiogroup", "aria-label": "Comment type" } });
  chips.createDiv({ cls: "terminus-review-intent-thumb", attr: { "aria-hidden": "true" } });
  const meaning = card.createDiv({ cls: "terminus-review-intent-meaning", attr: { "aria-live": "polite" } });
  const choose = (value: ReviewIntent, focus: "chip" | "text"): void => {
    intent = value;
    const index = INTENTS.indexOf(value);
    chips.style.setProperty("--terminus-review-thumb", String(index));
    for (const [i, el] of chipEls.entries()) {
      el.setAttr("aria-checked", String(i === index));
      el.tabIndex = i === index ? 0 : -1;
    }
    meaning.setText(hints[value]);
    textarea.placeholder = INTENT_PLACEHOLDERS[value];
    if (focus === "chip") chipEls[index]!.focus();
    else textarea.focus();
  };
  const chipEls = INTENTS.map((value, i) => {
    const chip = chips.createEl("button", {
      cls: "terminus-review-intent",
      attr: { type: "button", role: "radio", "aria-checked": "false" },
    });
    reviewIcon(chip, INTENT_ICONS[value]);
    chip.createSpan({ cls: "terminus-review-intent-label", text: INTENT_LABELS[value] });
    // Obsidian's tooltip is the accessible name too, so it starts with the
    // type's own name.
    setTooltip(chip, `${INTENT_LABELS[value]}: ${hints[value]}`, { placement: "top" });
    chip.addEventListener("click", () => choose(value, "text"));
    chip.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      const jump = event.key === "Home" ? 0 : event.key === "End" ? INTENTS.length - 1 : null;
      if (!step && jump === null) return;
      event.preventDefault();
      const next = jump ?? (i + step + INTENTS.length) % INTENTS.length;
      choose(INTENTS[next]!, "chip");
    });
    return chip;
  });
  const textarea = card.createEl("textarea", {
    cls: "terminus-review-text",
    attr: { rows: "3", placeholder: INTENT_PLACEHOLDERS[intent], "aria-label": "Your comment" },
  });
  choose(intent, "text");
  return {
    textarea,
    intent: () => intent,
    text: () => {
      const value = textarea.value.trim();
      return value || intent === "keep" ? value : null;
    },
  };
}

/** "⌘ ↵ to add", for the platform. Returns a setter for the action word,
 *  for a box whose main button changes. */
export function renderShortcutHint(parent: HTMLElement, action = "add"): (action: string) => void {
  const hint = parent.createSpan({ cls: "terminus-review-shortcut" });
  hint.createEl("kbd", { text: Platform.isMacOS ? "⌘" : "Ctrl" });
  hint.createEl("kbd", { text: "↵" });
  const word = hint.createSpan({ text: `to ${action}` });
  return (next) => word.setText(`to ${next}`);
}

/**
 * ⌘/Ctrl+Enter submits and Escape cancels in a review textarea. Listened
 * for on the window, in the capture phase: Obsidian's own hotkeys take
 * Mod+Enter there (it toggles a checkbox by default) and stop it before it
 * reaches the textarea. The listener goes once the textarea leaves the page.
 */
export function bindTextKeys(textarea: HTMLTextAreaElement, submit: () => void, cancel: () => void): void {
  const win = textarea.win;
  const onKey = (event: KeyboardEvent): void => {
    if (!textarea.isConnected) {
      win.removeEventListener("keydown", onKey, true);
      return;
    }
    if (event.target !== textarea) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  win.addEventListener("keydown", onKey, true);
}

/**
 * An icon set beside text. Wrapped in a flex box with the SVG as a block:
 * left inline, the SVG sits on the text's baseline and rides high of the
 * label's middle.
 */
export function reviewIcon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
  const wrap = parent.createSpan({ cls: cls ? ["terminus-review-icon", cls] : "terminus-review-icon" });
  setIcon(wrap, name);
  return wrap;
}
