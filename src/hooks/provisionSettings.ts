import { App, FileSystemAdapter, PluginManifest } from "obsidian";
import * as fs from "fs/promises";
import * as path from "path";

interface HookCommandEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface HookMatcherEntry {
  matcher: string;
  hooks: HookCommandEntry[];
}

interface ClaudeSettingsFile {
  hooks?: {
    PreToolUse?: HookMatcherEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const MATCHER = "Edit|Write|NotebookEdit";
// Short: the hook no longer waits on a human decision (see ReviewServer),
// just a local server round-trip to record the pre-edit snapshot, so this
// only needs to cover slow disk I/O, not review time.
const DEFAULT_TIMEOUT_SECONDS = 15;
const GITIGNORE_LINE = ".claude/settings.local.json";

export function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("Terminus requires a desktop vault (FileSystemAdapter)");
  }
  return adapter.getBasePath();
}

export function getHookBridgePath(app: App, manifest: PluginManifest): string {
  const basePath = getVaultBasePath(app);
  return path.join(basePath, app.vault.configDir, "plugins", manifest.id, "resources", "hook-bridge.sh");
}

/**
 * Idempotently ensures the vault's project-scoped .claude/settings.local.json
 * wires our PreToolUse hook, without clobbering any hooks or settings the
 * user already has there.
 */
export async function provisionClaudeSettings(app: App, manifest: PluginManifest): Promise<void> {
  const basePath = getVaultBasePath(app);
  const claudeDir = path.join(basePath, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  const hookCommand = getHookBridgePath(app, manifest);

  await fs.mkdir(claudeDir, { recursive: true });

  let settings: ClaudeSettingsFile = {};
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];

  const existingHook = settings.hooks.PreToolUse
    .flatMap((entry) => entry.hooks ?? [])
    .find((h) => h.command === hookCommand);

  let changed = false;
  if (!existingHook) {
    settings.hooks.PreToolUse.push({
      matcher: MATCHER,
      hooks: [{ type: "command", command: hookCommand, timeout: DEFAULT_TIMEOUT_SECONDS }],
    });
    changed = true;
  } else if (existingHook.timeout !== DEFAULT_TIMEOUT_SECONDS) {
    // Migrate vaults provisioned before the hook stopped waiting on a human.
    existingHook.timeout = DEFAULT_TIMEOUT_SECONDS;
    changed = true;
  }

  if (changed) {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }

  await ensureGitignoreEntry(basePath);
}

async function ensureGitignoreEntry(basePath: string): Promise<void> {
  const gitignorePath = path.join(basePath, ".gitignore");
  let existing = "";
  try {
    existing = await fs.readFile(gitignorePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const lines = existing.split("\n");
  if (lines.some((l) => l.trim() === GITIGNORE_LINE)) return;

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  const addition = `${needsNewline ? "\n" : ""}${GITIGNORE_LINE}\n`;
  await fs.appendFile(gitignorePath, addition, "utf8");
}
