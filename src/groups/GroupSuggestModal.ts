import { SuggestModal } from "obsidian";
import type { GroupTarget } from "./GroupController";
import type TerminusPlugin from "../main";

/** A group (null: Ungrouped, or no group selected), or a new group. */
export type GroupChoice = { kind: "group"; target: GroupTarget } | { kind: "new" };

interface Option {
  choice: GroupChoice;
  label: string;
}

/** Picks a group for "Switch group…" and "Move tab to group…". Moving
 *  offers "Move to new group" (terminals only) and "Remove from group". */
export class GroupSuggestModal extends SuggestModal<Option> {
  constructor(
    private plugin: TerminusPlugin,
    placeholder: string,
    private options: { mode: "switch" | "move"; offerNew?: boolean; offerRemove?: boolean },
    private onPick: (choice: GroupChoice) => void
  ) {
    super(plugin.app);
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): Option[] {
    const options: Option[] = this.plugin.groupStore.list().map((g) => ({ choice: { kind: "group", target: g.id }, label: g.name }));
    if (this.options.offerNew) options.push({ choice: { kind: "new" }, label: "New group" });
    // Moving: "Remove from group" only when there's a group to leave.
    // Switching: "No group" shows only ungrouped terminals.
    if (this.options.mode === "switch") options.push({ choice: { kind: "group", target: null }, label: "No group (ungrouped terminals only)" });
    else if (this.options.offerRemove) options.push({ choice: { kind: "group", target: null }, label: "Remove from group" });
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }

  renderSuggestion(option: Option, el: HTMLElement): void {
    el.setText(option.label);
  }

  onChooseSuggestion(option: Option): void {
    this.onPick(option.choice);
  }
}
