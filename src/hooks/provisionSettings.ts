import { App, FileSystemAdapter, PluginManifest } from "obsidian";
import { appendTextFile, makeDirRecursive, pathJoin, readTextFileIfExists, writeTextFile } from "terminus-node-bridge";

interface HookCommandEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcherEntry {
  /** Absent for events that don't run per-tool, e.g. Stop. */
  matcher?: string;
  hooks: HookCommandEntry[];
}

interface ClaudeSettingsFile {
  hooks?: {
    PreToolUse?: HookMatcherEntry[];
    Stop?: HookMatcherEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function isClaudeSettingsFile(value: unknown): value is ClaudeSettingsFile {
  return typeof value === "object" && value !== null;
}

const MATCHER = "Edit|Write|NotebookEdit";
// Short: the hook no longer waits on a human decision (see ReviewServer),
// just a local server round-trip to record the pre-edit snapshot, so this
// only needs to cover slow disk I/O, not review time.
const DEFAULT_TIMEOUT_SECONDS = 15;
// Shorter still: the Stop bridge posts a bodyless "turn is over" ping and
// reads nothing back, and it runs while Claude is trying to finish -- so it
// gets the tightest budget of the two.
const TURN_END_TIMEOUT_SECONDS = 10;
const GITIGNORE_LINE = ".claude/settings.local.json";

export function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("Terminus requires a desktop vault (FileSystemAdapter)");
  }
  return adapter.getBasePath();
}

function resourcePath(app: App, manifest: PluginManifest, fileName: string): string {
  const basePath = getVaultBasePath(app);
  return pathJoin(basePath, app.vault.configDir, "plugins", manifest.id, "resources", fileName);
}

export function getHookBridgePath(app: App, manifest: PluginManifest): string {
  return resourcePath(app, manifest, "hook-bridge.sh");
}

export function getTurnEndBridgePath(app: App, manifest: PluginManifest): string {
  return resourcePath(app, manifest, "turn-end-bridge.sh");
}

/**
 * Idempotently ensures the vault's project-scoped .claude/settings.local.json
 * wires both of our hooks -- PreToolUse (record each write for review) and
 * Stop (turn is over) -- without clobbering any hooks or settings the user
 * already has there.
 */
export async function provisionClaudeSettings(app: App, manifest: PluginManifest): Promise<void> {
  const basePath = getVaultBasePath(app);
  const claudeDir = pathJoin(basePath, ".claude");
  const settingsPath = pathJoin(claudeDir, "settings.local.json");

  await makeDirRecursive(claudeDir);

  const raw = await readTextFileIfExists(settingsPath);
  let settings: ClaudeSettingsFile = {};
  if (raw && raw.trim()) {
    const parsed: unknown = JSON.parse(raw);
    if (isClaudeSettingsFile(parsed)) settings = parsed;
  }

  const hooks = (settings.hooks ??= {});

  // Two separate ensure calls rather than one loop over a table: the events
  // differ in more than their command string (Stop takes no matcher, since
  // it isn't tied to a tool), and the table would be longer than this.
  const preToolUseChanged = ensureHook(hooks, "PreToolUse", {
    matcher: MATCHER,
    command: getHookBridgePath(app, manifest),
    timeout: DEFAULT_TIMEOUT_SECONDS,
  });
  const stopChanged = ensureHook(hooks, "Stop", {
    command: getTurnEndBridgePath(app, manifest),
    timeout: TURN_END_TIMEOUT_SECONDS,
  });

  if (preToolUseChanged || stopChanged) {
    await writeTextFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  await ensureGitignoreEntry(basePath);
}

/**
 * Adds one hook entry for `event` if the user's file doesn't already have it,
 * and migrates its timeout if we've since changed our mind about the value.
 * Matched on the command path alone -- that's the part that identifies the
 * entry as ours, and rewriting a matcher the user has deliberately widened
 * would be us clobbering their file. Returns whether anything changed, so the
 * caller can skip the write entirely on the common no-op load.
 */
function ensureHook(
  hooks: NonNullable<ClaudeSettingsFile["hooks"]>,
  event: "PreToolUse" | "Stop",
  spec: { matcher?: string; command: string; timeout: number }
): boolean {
  const entries = (hooks[event] ??= []);

  const existing = entries.flatMap((entry) => entry.hooks ?? []).find((h) => h.command === spec.command);
  if (!existing) {
    entries.push({
      // Omitted entirely for Stop: it doesn't run per-tool, so there's
      // nothing for a matcher to match against.
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [{ type: "command", command: spec.command, timeout: spec.timeout }],
    });
    return true;
  }
  if (existing.timeout !== spec.timeout) {
    // Migrate vaults provisioned before we settled on this budget (e.g. the
    // PreToolUse hook back when it still waited on a human decision).
    existing.timeout = spec.timeout;
    return true;
  }
  return false;
}

async function ensureGitignoreEntry(basePath: string): Promise<void> {
  const gitignorePath = pathJoin(basePath, ".gitignore");
  const existing = (await readTextFileIfExists(gitignorePath)) ?? "";

  const lines = existing.split("\n");
  if (lines.some((l) => l.trim() === GITIGNORE_LINE)) return;

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const addition = `${needsNewline ? "\n" : ""}${GITIGNORE_LINE}\n`;
  await appendTextFile(gitignorePath, addition);
}
