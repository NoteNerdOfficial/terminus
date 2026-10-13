import { SuggestModal } from "obsidian";
import type { GroupTarget } from "./GroupController";
import type TerminusPlugin from "../main";

/** A group (null: Ungrouped, or no group selected), or a new group. */
export type GroupChoice = { kind: "group"; target: GroupTarget } | { kind: "new" };

interface Option {
  choice: GroupChoice;
  label: string;
}

/** Picks a group for the "Switch group…" and "Move terminal to group…"
 *  commands. `offerNew` adds "New group" for moving. */
export class GroupSuggestModal extends SuggestModal<Option> {
  constructor(
    private plugin: TerminusPlugin,
    placeholder: string,
    private offerNew: boolean,
    private onPick: (choice: GroupChoice) => void
  ) {
    super(plugin.app);
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): Option[] {
    const options: Option[] = this.plugin.groupStore.list().map((g) => ({ choice: { kind: "group", target: g.id }, label: g.name }));
    options.push({ choice: { kind: "group", target: null }, label: this.offerNew ? "Ungrouped" : "No group (ungrouped terminals only)" });
    if (this.offerNew) options.push({ choice: { kind: "new" }, label: "New group" });
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
