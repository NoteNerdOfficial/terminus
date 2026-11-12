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

  /** Resolves once a write containing this entry has reached disk. Appends
   *  that arrive while a write is in flight (a Keep all of many files fires
   *  one per file, synchronously) share the single write that follows it,
   *  instead of each re-serializing and rewriting the whole file at once. */
  async append(entry: ActionLogEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
    }
    await this.schedulePersist();
  }

  list(query?: ActionLogQuery): ActionLogEntry[] {
    let result = [...this.entries].reverse(); // newest first
    const search = query?.search?.trim().toLowerCase();
    if (search) {
      result = result.filter((e) => e.filePath.toLowerCase().includes(search));
    }
    return result;
  }

  private writing: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  private schedulePersist(): Promise<void> {
    if (this.queued) return this.queued;
    if (!this.writing) {
      this.writing = this.persist().finally(() => (this.writing = null));
      return this.writing;
    }
    // A write is already under way and may predate this entry: queue one
    // more, which every later append joins until it starts.
    const after = this.writing.catch(() => undefined);
    this.queued = after.then(() => {
      this.queued = null;
      return this.schedulePersist();
    });
    return this.queued;
  }

  private async persist(): Promise<void> {
    await makeDirRecursive(pathDirname(this.logFilePath));
    await writeTextFile(this.logFilePath, JSON.stringify(this.entries, null, 2));
  }
}
