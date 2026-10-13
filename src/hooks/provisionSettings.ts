import { App, FileSystemAdapter, PluginManifest } from "obsidian";
import { appendTextFile, makeDirRecursive, pathJoin, readTextFileIfExists, writeTextFile } from "terminus-node-bridge";
import type { Experience } from "../settings";

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
  hooks?: Partial<Record<HookEvent, HookMatcherEntry[]>> & { [key: string]: unknown };
  [key: string]: unknown;
}

function isClaudeSettingsFile(value: unknown): value is ClaudeSettingsFile {
  return typeof value === "object" && value !== null;
}

type HookEvent =
  | "PreToolUse"
  | "Stop"
  | "Notification"
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "StopFailure"
  | "SubagentStart"
  | "SubagentStop";

/** Hooks only the Multi-agent experience installs, all through the one
 *  session-event bridge. Switching back to Classic removes them again, so a
 *  Classic vault's settings file looks exactly as it did before. */
const MULTI_AGENT_ONLY_EVENTS: HookEvent[] = ["SessionStart", "SessionEnd", "UserPromptSubmit", "StopFailure"];

/** Subagent tracking's hooks, also on the session-event bridge: installed
 *  only in Multi-agent with "Track subagents" on. */
const SUBAGENT_EVENTS: HookEvent[] = ["SubagentStart", "SubagentStop"];

const MATCHER = "Edit|Write|NotebookEdit";
/** The lead's Agent tool call, for the subagent's task description. "Task"
 *  is the tool's older name. A separate PreToolUse entry on the session-event
 *  bridge, so it never reaches hook-bridge.sh's snapshot code. */
const AGENT_MATCHER = "Agent|Task";
// Short: the hook no longer waits on a human decision (see ReviewServer),
// just a local server round-trip to record the pre-edit snapshot, so this
// only needs to cover slow disk I/O, not review time.
const DEFAULT_TIMEOUT_SECONDS = 15;
// Shorter still: the Stop bridge posts a bodyless "turn is over" ping and
// reads nothing back, and it runs while Claude is trying to finish -- so it
// gets the tightest budget of the two.
const TURN_END_TIMEOUT_SECONDS = 10;
// Same bodyless-ping shape as Stop, and same reasoning: nothing here should
// ever be slow enough to need more than a few seconds.
const NOTIFICATION_TIMEOUT_SECONDS = 5;
// Same again: one small POST, and SessionStart/UserPromptSubmit run while
// the user is waiting for Claude to start.
const SESSION_EVENT_TIMEOUT_SECONDS = 5;
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

export function getNotificationBridgePath(app: App, manifest: PluginManifest): string {
  return resourcePath(app, manifest, "notification-bridge.sh");
}

export function getSessionEventBridgePath(app: App, manifest: PluginManifest): string {
  return resourcePath(app, manifest, "session-event-bridge.sh");
}

export interface HookOptions {
  experience: Experience;
  /** Only honoured in Multi-agent. */
  trackSubagents: boolean;
}

/**
 * Idempotently ensures the vault's project-scoped .claude/settings.local.json
 * wires our hooks for the given options -- always PreToolUse (record each
 * write for review), Stop (turn is over), and Notification (Claude needs
 * permission or is waiting on the user); in Multi-agent also SessionStart,
 * SessionEnd, UserPromptSubmit and StopFailure, plus, while subagents are tracked, the
 * Agent tool's PreToolUse, SubagentStart and SubagentStop. Hooks the options
 * don't call for are removed. Never clobbers hooks or settings the user
 * already has there.
 */
export async function provisionClaudeSettings(app: App, manifest: PluginManifest, options: HookOptions): Promise<void> {
  const multiAgent = options.experience === "multi-agent";
  const trackSubagents = multiAgent && options.trackSubagents;

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

  // Separate ensure calls rather than one loop over a table: the events
  // differ in more than their command string (Stop and Notification take no
  // matcher, since neither is tied to a tool), and the table would be longer
  // than this.
  const preToolUseChanged = ensureHook(hooks, "PreToolUse", {
    matcher: MATCHER,
    command: getHookBridgePath(app, manifest),
    timeout: DEFAULT_TIMEOUT_SECONDS,
  });
  const stopChanged = ensureHook(hooks, "Stop", {
    command: getTurnEndBridgePath(app, manifest),
    timeout: TURN_END_TIMEOUT_SECONDS,
  });
  const notificationChanged = ensureHook(hooks, "Notification", {
    command: getNotificationBridgePath(app, manifest),
    timeout: NOTIFICATION_TIMEOUT_SECONDS,
  });

  const sessionEventBridge = getSessionEventBridgePath(app, manifest);
  const sessionHook = { command: sessionEventBridge, timeout: SESSION_EVENT_TIMEOUT_SECONDS };
  let sessionHooksChanged = false;
  for (const event of MULTI_AGENT_ONLY_EVENTS) {
    const changed = multiAgent ? ensureHook(hooks, event, sessionHook) : removeHook(hooks, event, sessionEventBridge);
    sessionHooksChanged ||= changed;
  }
  for (const event of SUBAGENT_EVENTS) {
    const changed = trackSubagents ? ensureHook(hooks, event, sessionHook) : removeHook(hooks, event, sessionEventBridge);
    sessionHooksChanged ||= changed;
  }
  // The same command path under PreToolUse is only ever this entry, so
  // ensureHook/removeHook's command match finds it beside hook-bridge.sh's.
  const agentToolChanged = trackSubagents
    ? ensureHook(hooks, "PreToolUse", { ...sessionHook, matcher: AGENT_MATCHER })
    : removeHook(hooks, "PreToolUse", sessionEventBridge);
  sessionHooksChanged ||= agentToolChanged;

  if (preToolUseChanged || stopChanged || notificationChanged || sessionHooksChanged) {
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
  event: HookEvent,
  spec: { matcher?: string; command: string; timeout: number }
): boolean {
  const entries = (hooks[event] ??= []);

  const existing = entries.flatMap((entry) => entry.hooks ?? []).find((h) => h.command === spec.command);
  if (!existing) {
    entries.push({
      // Omitted entirely for Stop/Notification: neither runs per-tool, so
      // there's nothing for a matcher to match against.
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

/**
 * Removes our entry for `event` (matched on the command path, like
 * ensureHook) and tidies up after it: a matcher group left with no hooks is
 * dropped, and so is the event itself once nothing else is under it. Any
 * hook the user added under the same event stays. Returns whether anything
 * changed.
 */
function removeHook(hooks: NonNullable<ClaudeSettingsFile["hooks"]>, event: HookEvent, command: string): boolean {
  const entries = hooks[event];
  if (!entries) return false;

  let changed = false;
  for (const entry of entries) {
    const kept = (entry.hooks ?? []).filter((h) => h.command !== command);
    if (kept.length !== (entry.hooks ?? []).length) {
      entry.hooks = kept;
      changed = true;
    }
  }
  if (!changed) return false;

  const remaining = entries.filter((entry) => (entry.hooks ?? []).length > 0);
  if (remaining.length > 0) hooks[event] = remaining;
  else delete hooks[event];
  return true;
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
