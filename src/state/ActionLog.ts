import { makeDirRecursive, pathDirname, readTextFileIfExists, writeTextFile } from "terminus-node-bridge";

export interface ActionLogEntry {
  timestamp: number;
  filePath: string;
  accepted: boolean;
  editCount: number;
  added: number;
  removed: number;
  toolName: string;
}

export interface ActionLogQuery {
  search?: string;
}

function isActionLogEntryArray(value: unknown): value is ActionLogEntry[] {
  return Array.isArray(value);
}

// Deliberately lightweight: filename + stats + outcome, not full diff text.
// Undo needs the full revertText/newText to actually reverse a change, which
// is why that stays a separate, small, in-memory list (PendingChangesStore's
// history) -- persisting full file content for every resolved change,
// forever, would make this file grow without bound. This is an audit trail,
// not an undo source.
const MAX_LOG_ENTRIES = 1000;

export class ActionLog {
  private entries: ActionLogEntry[] = [];
  private loaded = false;

  constructor(private logFilePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await readTextFileIfExists(this.logFilePath);
    if (raw && raw.trim()) {
      const parsed: unknown = JSON.parse(raw);
      this.entries = isActionLogEntryArray(parsed) ? parsed : [];
    } else {
      this.entries = [];
    }
    this.loaded = true;
  }

  async append(entry: ActionLogEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    await this.persist();
  }

  list(query?: ActionLogQuery): ActionLogEntry[] {
    let result = [...this.entries].reverse(); // newest first
    const search = query?.search?.trim().toLowerCase();
    if (search) {
      result = result.filter((e) => e.filePath.toLowerCase().includes(search));
    }
    return result;
  }

  private async persist(): Promise<void> {
    await makeDirRecursive(pathDirname(this.logFilePath));
    await writeTextFile(this.logFilePath, JSON.stringify(this.entries, null, 2));
  }
}
