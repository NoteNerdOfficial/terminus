import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionLog, type ActionLogEntry } from "../src/state/ActionLog";

function entry(i: number): ActionLogEntry {
  return { timestamp: i, filePath: `/vault/note-${i}.md`, accepted: true, editCount: 1, added: 1, removed: 0, toolName: "Edit" };
}

describe("action log: a burst of appends", () => {
  it("lands every entry, in order, when they all arrive at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-log-"));
    try {
      const file = join(dir, "logs", "action-log.json");
      const log = new ActionLog(file);
      await log.load();
      await Promise.all(Array.from({ length: 300 }, (_, i) => log.append(entry(i))));
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as ActionLogEntry[];
      assert.deepEqual(onDisk.map((e) => e.timestamp), Array.from({ length: 300 }, (_, i) => i));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes an entry appended while a write is under way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terminus-log-"));
    try {
      const file = join(dir, "action-log.json");
      const log = new ActionLog(file);
      await log.load();
      const first = log.append(entry(0));
      await Promise.resolve();
      await log.append(entry(1));
      await first;
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as ActionLogEntry[];
      assert.deepEqual(onDisk.map((e) => e.timestamp), [0, 1]);
      await log.append(entry(2));
      assert.equal((JSON.parse(readFileSync(file, "utf8")) as ActionLogEntry[]).length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
