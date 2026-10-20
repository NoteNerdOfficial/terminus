import { TFile, TFolder } from "./obsidian-stub";
import { AgentSessionStore } from "../../src/state/AgentSessionStore";
import type { DiffResult } from "../../src/server/diff";
import type TerminusPlugin from "../../src/main";

/**
 * An in-memory stand-in for the parts of Obsidian that SessionLog writes
 * through: a vault that can create folders and files and append to them, a
 * metadata cache that parses frontmatter, and processFrontMatter.
 *
 * Small on purpose. It exists so the lifecycle tests can assert on the exact
 * bytes a session leaves in a vault, which is the thing that has actually
 * broken twice (turn numbering across a restart, and past the store's cap).
 */
export class FakeFile extends TFile {
  constructor(path: string, public data: string) {
    super();
    this.path = path;
    this.extension = path.split(".").pop() ?? "md";
  }
}

export class FakeFolder extends TFolder {
  constructor(path: string) {
    super();
    this.path = path;
  }
}

export interface FakeVault {
  app: unknown;
  files: Map<string, FakeFile>;
  frontmatter: Map<string, Record<string, unknown>>;
  /** The single note a test wrote, when it expects exactly one. */
  onlyNote(): FakeFile;
  /** The turn numbers a note's headings claim, in order. */
  turnNumbers(file?: FakeFile): number[];
}

export function makeVault(): FakeVault {
  const files = new Map<string, FakeFile>();
  const folders = new Map<string, FakeFolder>();
  const frontmatter = new Map<string, Record<string, unknown>>();

  const parentOf = (path: string) => folders.get(path.split("/").slice(0, -1).join("/"));

  const vault = {
    getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path) ?? null,
    createFolder: async (path: string) => {
      if (folders.has(path)) throw new Error("folder already exists");
      const folder = new FakeFolder(path);
      folders.set(path, folder);
      parentOf(path)?.children.push(folder);
      return folder;
    },
    create: async (path: string, data: string) => {
      const file = new FakeFile(path, data);
      files.set(path, file);
      parentOf(path)?.children.push(file);
      frontmatter.set(path, parseFrontmatter(data));
      return file;
    },
    append: async (file: FakeFile, data: string) => {
      file.data += data;
    },
    cachedRead: async (file: FakeFile) => file.data,
  };

  const app = {
    vault,
    metadataCache: { getFileCache: (file: FakeFile) => ({ frontmatter: frontmatter.get(file.path) }) },
    fileManager: {
      processFrontMatter: async (file: FakeFile, apply: (fm: Record<string, unknown>) => void) => {
        const fm = frontmatter.get(file.path) ?? {};
        apply(fm);
        frontmatter.set(file.path, fm);
      },
    },
  };

  return {
    app,
    files,
    frontmatter,
    onlyNote() {
      if (files.size !== 1) throw new Error(`expected exactly one note, found ${files.size}`);
      return [...files.values()][0] as FakeFile;
    },
    turnNumbers(file?: FakeFile) {
      const target = file ?? this.onlyNote();
      return [...target.data.matchAll(/^## Turn (\d+)/gm)].map((match) => Number(match[1]));
    },
  };
}

/** Enough YAML for what the log writes: flat `key: value` pairs. */
function parseFrontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, unknown> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) out[line.slice(0, colon)] = line.slice(colon + 1).trim().replace(/^"|"$/g, "");
  }
  return out;
}

/**
 * A plugin with only the members SessionLog reaches. Cast rather than
 * implemented: the real TerminusPlugin is an Obsidian Plugin subclass, and
 * standing one up would pull in the whole app for the handful of fields the
 * log actually touches.
 */
export function makePlugin(store: AgentSessionStore, app: unknown, overrides: Record<string, unknown> = {}): TerminusPlugin {
  return {
    app,
    experience: "multi-agent",
    settings: { multiAgent: { logSessions: true, sessionLogFolder: "Terminus/Sessions" } },
    agentSessionStore: store,
    pendingChangesStore: { get: () => undefined },
    findTerminalView: () => ({ getDisplayText: () => "Terminus 1" }),
    getVaultBasePath: () => "/vault",
    ...overrides,
  } as unknown as TerminusPlugin;
}

export function fakeDiff(filePath: string): DiffResult {
  return { filePath, oldText: "a\n", newText: "b\nc\n", revertText: "a\n", existedBefore: true } as DiffResult;
}

export function identity(sessionId: string) {
  return { sessionId, transcriptPath: "/t.jsonl", cwd: "/vault" };
}

/** Lets writes queued inside SessionLog settle before asserting. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
