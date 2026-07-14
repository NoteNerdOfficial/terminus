import { App, Modal } from "obsidian";
import * as path from "path";
import { ActionLog, ActionLogEntry } from "../state/ActionLog";

export class ActionLogModal extends Modal {
  constructor(app: App, private actionLog: ActionLog) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("terminus-action-log-modal");
    contentEl.createEl("h3", { text: "Action Log" });

    const searchInput = contentEl.createEl("input", {
      type: "text",
      placeholder: "Search by filename…",
      cls: "terminus-action-log-search",
    });

    const list = contentEl.createDiv({ cls: "terminus-action-log-list" });

    const render = (search?: string) => {
      list.empty();
      const entries = this.actionLog.list({ search });
      if (entries.length === 0) {
        list.createEl("div", { text: "No matching entries", cls: "terminus-pending-empty" });
        return;
      }
      for (const entry of entries) {
        this.renderRow(list, entry);
      }
    };

    searchInput.addEventListener("input", () => render(searchInput.value));
    searchInput.focus();
    render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderRow(list: HTMLElement, entry: ActionLogEntry): void {
    const row = list.createDiv({ cls: "terminus-action-log-row" });
    row.createEl("span", {
      cls: entry.accepted ? "terminus-diff-stat-add" : "terminus-diff-stat-remove",
      text: entry.accepted ? "Kept" : "Reverted",
    });
    row.createEl("span", { cls: "terminus-history-filename", text: path.basename(entry.filePath) });
    row.createEl("span", {
      cls: "terminus-pending-edit-count",
      text: `+${entry.added} -${entry.removed}${entry.editCount > 1 ? ` · ${entry.editCount} edits` : ""}`,
    });
    row.createEl("span", { cls: "terminus-pending-path", text: new Date(entry.timestamp).toLocaleString() });
  }
}
