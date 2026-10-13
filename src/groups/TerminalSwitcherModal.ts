import { prepareFuzzySearch, SuggestModal } from "obsidian";
import type { TerminalView } from "../views/TerminalView";
import type { TerminalGroup } from "../state/GroupStore";
import type TerminusPlugin from "../main";

type Status = "needs-attention" | "working" | "finished-unread" | "idle" | "shell";

const STATUS_LABEL: Record<Status, string> = {
  "needs-attention": "Needs attention",
  working: "Working",
  "finished-unread": "Finished",
  idle: "Idle",
  shell: "Shell",
};

/** Most urgent first: what you'd want to jump to. */
const STATUS_RANK: Record<Status, number> = { "needs-attention": 0, working: 1, "finished-unread": 2, idle: 3, shell: 4 };

type Item =
  | { kind: "terminal"; view: TerminalView; name: string; group: TerminalGroup | undefined; status: Status }
  | { kind: "group"; group: TerminalGroup; count: number };

/**
 * "Go to terminal or group…": a fuzzy picker over every terminal (with its
 * group and what its Claude session is doing) and every group, urgent ones
 * first. Opening a terminal switches to its group the way clicking it does.
 */
export class TerminalSwitcherModal extends SuggestModal<Item> {
  constructor(private plugin: TerminusPlugin) {
    super(plugin.app);
    this.setPlaceholder("Go to a terminal or group");
  }

  private items(): Item[] {
    const groups = this.plugin.groupStore;
    const terminals = this.plugin.groups.terminals();
    const items: Item[] = terminals.map((view) => {
      const session = this.plugin.agentSessionStore.get(view.hookToken);
      return {
        kind: "terminal",
        view,
        name: view.getDisplayText(),
        group: groups.get(view.groupId),
        status: session?.running ? session.status : "shell",
      };
    });
    items.sort((a, b) => rank(a) - rank(b));
    for (const group of groups.list()) {
      items.push({ kind: "group", group, count: terminals.filter((t) => t.groupId === group.id).length });
    }
    return items;
  }

  getSuggestions(query: string): Item[] {
    const items = this.items();
    const q = query.trim();
    if (!q) return items;
    const match = prepareFuzzySearch(q);
    const scored: Array<{ item: Item; score: number }> = [];
    for (const item of items) {
      const result = match(searchText(item));
      if (result) scored.push({ item, score: result.score });
    }
    // Best match first; urgency breaks ties (the sort is stable).
    scored.sort((a, b) => b.score - a.score || rank(a.item) - rank(b.item));
    return scored.map((entry) => entry.item);
  }

  renderSuggestion(item: Item, el: HTMLElement): void {
    el.addClass("terminus-switcher-item");
    if (item.kind === "terminal") {
      el.createSpan({ cls: "terminus-switcher-name", text: item.name });
      el.createSpan({ cls: "terminus-switcher-meta", text: item.group?.name ?? "Ungrouped" });
      el.createSpan({ cls: `terminus-switcher-status is-${item.status}`, text: STATUS_LABEL[item.status] });
      return;
    }
    el.createSpan({ cls: "terminus-switcher-name", text: item.group.name });
    const settled = item.group.settledAt !== null ? " · done" : item.group.snoozedUntil !== null ? " · snoozed" : "";
    el.createSpan({ cls: "terminus-switcher-meta", text: `Group · ${item.count} ${item.count === 1 ? "terminal" : "terminals"}${settled}` });
  }

  onChooseSuggestion(item: Item): void {
    if (item.kind === "terminal") void this.plugin.focusTerminal(item.view.hookToken);
    else void this.plugin.groups.selectGroup(item.group.id);
  }
}

function rank(item: Item): number {
  // Groups sort after every terminal.
  return item.kind === "terminal" ? STATUS_RANK[item.status] : 10;
}

function searchText(item: Item): string {
  return item.kind === "terminal" ? `${item.name} ${item.group?.name ?? "ungrouped"}` : `${item.group.name} group`;
}
