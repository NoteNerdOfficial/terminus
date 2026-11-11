import { Notice, type WorkspaceLeaf } from "obsidian";
import type TerminusPlugin from "../main";
import type { AgentSession } from "../state/AgentSessionStore";
import type { TerminalView } from "../views/TerminalView";
import {
  ApiError,
  RateLimiter,
  WAITABLE_STATUSES,
  asParams,
  bypassFlagIn,
  findMatchingLine,
  optionalBool,
  optionalChoice,
  optionalInt,
  optionalString,
  publicStatus,
  requireString,
  tailLines,
  type Params,
  type PublicStatus,
} from "./policy";

/** An agent opened by an agent may not open more: one level of helpers,
 *  never a tree that grows on its own. */
const MAX_OPEN_DEPTH = 1;
/** Opens, runs, prompts and delegations together, per calling terminal. */
const ACTION_LIMIT = 40;
const ACTION_WINDOW_MS = 10 * 60 * 1000;
/** Under Claude Code's default two-minute Bash timeout, so a plain
 *  `wait` returns an answer rather than being killed. */
const DEFAULT_WAIT_MS = 100_000;
/** Under Node's own five-minute request timeout. */
const MAX_WAIT_MS = 280_000;
const OUTPUT_POLL_MS = 400;
const MAX_RESULT_LENGTH = 100_000;
const MAX_STATUS_LENGTH = 120;
const PLACEMENTS = ["tab", "split-right", "split-down"] as const;

interface OpenRecord {
  /** The token of the terminal that opened it. */
  by: string;
  depth: number;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * The agent API: what an agent running in a Terminus terminal can ask
 * Terminus to do, through `POST /api` on the review server (see
 * resources/terminus_cli.py for the client and SKILL_MD for how agents
 * are told about it). The caller is identified by its terminal's token,
 * which only processes started in that terminal have.
 *
 * Every method is scoped to the caller's own group: an agent can see and
 * reach the terminals beside it, never the rest of the workspace. Off
 * unless the user turns on agent control, and Multi-agent only.
 */
export class AgentApi {
  private opened = new Map<string, OpenRecord>();
  private actions = new RateLimiter(ACTION_LIMIT, ACTION_WINDOW_MS);
  /** Each terminal's last closing message in full; the session store keeps
   *  a preview. */
  private results = new Map<string, string>();
  /** What an agent says it's doing (`status`), shown on its inbox card
   *  while its turn lasts. */
  private statusLines = new Map<string, string>();

  constructor(private plugin: TerminusPlugin) {}

  /** Wires the API to the session store. Called once from onload. */
  start(): void {
    this.plugin.agentSessionStore.on("change", (session) => this.onSessionChange(session));
  }

  /** From TerminalView as each turn ends, with the closing message. */
  recordResult(token: string, message: string | undefined): void {
    if (message === undefined) return;
    this.results.set(token, message.length > MAX_RESULT_LENGTH ? message.slice(0, MAX_RESULT_LENGTH) : message);
  }

  statusLine(token: string): string | null {
    return this.statusLines.get(token) ?? null;
  }

  /** Whether an agent opened this terminal, and which one. */
  openedBy(token: string): string | null {
    return this.opened.get(token)?.by ?? null;
  }

  async handle(callerToken: string, request: unknown): Promise<ApiResponse> {
    try {
      const { method, params } = parseRequest(request);
      const caller = this.plugin.findTerminalView(callerToken);
      if (!caller) throw new ApiError("forbidden", "This terminal is no longer open in Terminus", 403);
      if (this.plugin.experience !== "multi-agent") {
        throw new ApiError("disabled", "Agent control needs the Multi-agent experience (Terminus settings → Experience)", 403);
      }
      if (!this.plugin.settings.agentControl.enabled) {
        throw new ApiError(
          "disabled",
          "Agent control is off. The user can turn it on in Terminus settings → Agent control → Let agents control Terminus.",
          403
        );
      }
      const result = await this.dispatch(caller, method, params);
      return { status: 200, body: { ok: true, result } };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.httpStatus, body: { ok: false, error: { code: err.code, message: err.message } } };
      return { status: 500, body: { ok: false, error: { code: "internal", message: err instanceof Error ? err.message : String(err) } } };
    }
  }

  private dispatch(caller: TerminalView, method: string, params: Params): Promise<unknown> | unknown {
    switch (method) {
      case "whoami":
        return this.whoami(caller);
      case "terminal.list":
        return { terminals: this.scope(caller).map((view) => this.describe(view, caller)) };
      case "terminal.open":
        return this.open(caller, params);
      case "terminal.run":
        return this.run(caller, params);
      case "terminal.read":
        return this.read(caller, params);
      case "terminal.wait_output":
        return this.waitOutput(caller, params);
      case "terminal.close":
        return this.close(caller, params);
      case "notify":
        return this.notify(caller, params);
      case "status":
        return this.setStatus(caller, params);
      case "agent.prompt":
        return this.prompt(caller, params);
      case "agent.wait":
        return this.wait(caller, params);
      case "agent.result":
        return this.result(caller, params);
      case "agent.delegate":
        return this.delegate(caller, params);
      default:
        throw new ApiError("unknown_method", `Unknown method "${method}"`, 404);
    }
  }

  // ---- Methods ----

  private whoami(caller: TerminalView): unknown {
    const group = caller.groupId ? this.plugin.groupStore.get(caller.groupId) : undefined;
    return {
      ...this.describe(caller, caller),
      group: group?.name ?? null,
      can_open: this.openRefusal(caller) === null,
      max_opened_terminals: this.plugin.settings.agentControl.maxOpenedTerminals,
    };
  }

  private async open(caller: TerminalView, params: Params): Promise<unknown> {
    const command = optionalString(params, "command", 2000);
    const prompt = optionalString(params, "prompt");
    if (prompt !== undefined && command === undefined) {
      throw new ApiError("invalid_params", '"prompt" needs a "command" that starts an agent, such as "claude"');
    }
    if (command !== undefined) this.refuseBypass(command);
    const name = optionalString(params, "name", 60);
    const child = await this.openTerminal(caller, {
      command: command ?? "",
      prompt,
      cwd: optionalString(params, "cwd", 1000) ?? caller.shellCwd ?? undefined,
      label: name ?? command ?? "terminal",
      placement: optionalChoice(params, "placement", PLACEMENTS, "tab"),
    });
    return this.describe(child, caller);
  }

  private run(caller: TerminalView, params: Params): unknown {
    const target = this.target(caller, params, true);
    const command = requireString(params, "command", 2000);
    this.refuseBypass(command);
    const status = publicStatus(this.plugin.agentSessionStore.get(target.hookToken));
    if (status !== "none" && status !== "ended") {
      throw new ApiError("agent_running", `${target.publicId} is running Claude; send it a message with "prompt" instead`, 409);
    }
    this.takeAction(caller);
    if (!target.runCommand(command)) throw new ApiError("unavailable", `${target.publicId}'s shell isn't running`, 409);
    return { id: target.publicId };
  }

  private read(caller: TerminalView, params: Params): unknown {
    const target = this.target(caller, params, true);
    const lines = optionalInt(params, "lines", 80, 1, 5000);
    return { id: target.publicId, text: tailLines(target.readLines(), lines).join("\n") };
  }

  private async waitOutput(caller: TerminalView, params: Params): Promise<unknown> {
    const target = this.target(caller, params, true);
    const pattern = requireString(params, "pattern", 1000);
    const regex = optionalBool(params, "regex");
    const lines = optionalInt(params, "lines", 80, 1, 5000);
    const timeout = optionalInt(params, "timeout_ms", DEFAULT_WAIT_MS, 1000, MAX_WAIT_MS);
    // Validates the expression before waiting on it.
    findMatchingLine([], pattern, regex);
    const matched = await this.waitFor(
      () => {
        if (!this.plugin.findTerminalView(target.hookToken)) throw new ApiError("closed", `${target.publicId} was closed`, 410);
        return findMatchingLine(tailLines(target.readLines(), lines), pattern, regex);
      },
      timeout,
      false,
      `Nothing matching "${pattern}" in ${target.publicId}'s last ${lines} lines`
    );
    return { id: target.publicId, matched_line: matched };
  }

  private close(caller: TerminalView, params: Params): unknown {
    const target = this.target(caller, params, false);
    if (this.opened.get(target.hookToken)?.by !== caller.hookToken) {
      throw new ApiError("forbidden", `${target.publicId} wasn't opened by you; only the user can close it`, 403);
    }
    target.leaf.detach();
    this.opened.delete(target.hookToken);
    return { id: target.publicId, closed: true };
  }

  private notify(caller: TerminalView, params: Params): unknown {
    const body = requireString(params, "body", 300);
    const title = optionalString(params, "title", 80) ?? null;
    return { shown: this.plugin.notifier.message(caller.hookToken, title, body) };
  }

  private setStatus(caller: TerminalView, params: Params): unknown {
    const text = optionalString(params, "text", 1000)?.replace(/\s+/g, " ").trim();
    if (text) this.statusLines.set(caller.hookToken, text.slice(0, MAX_STATUS_LENGTH));
    else this.statusLines.delete(caller.hookToken);
    this.plugin.refreshTerminusViews();
    return { status: this.statusLine(caller.hookToken) };
  }

  private async prompt(caller: TerminalView, params: Params): Promise<unknown> {
    const target = this.target(caller, params, false);
    const text = requireString(params, "text");
    const mode = optionalChoice(params, "mode", ["queue", "steer"] as const, "queue");
    const session = this.plugin.agentSessionStore.get(target.hookToken);
    if (!session?.running) throw new ApiError("no_agent", `${target.publicId} isn't running Claude`, 409);
    this.takeAction(caller);
    // Says who is talking, so the reply can find its way back.
    const message = `Message from ${caller.getDisplayText()} (Terminus terminal ${caller.publicId}):\n\n${text}`;
    if (mode === "steer") {
      const readiness = this.plugin.steerReadiness(target.hookToken);
      if (!readiness.ready) throw new ApiError("agent_blocked", `${target.publicId}: ${readiness.reason}. Use mode "queue" to send it once it's free.`, 409);
      if (!(await this.plugin.sendGuidance(target.hookToken, message, true))) {
        throw new ApiError("unavailable", `Couldn't type into ${target.publicId}`, 409);
      }
    } else if (!this.plugin.queueGuidance(target.hookToken, message)) {
      throw new ApiError("unavailable", `Couldn't queue a message for ${target.publicId}`, 409);
    }
    return { id: target.publicId, mode, status: publicStatus(this.plugin.agentSessionStore.get(target.hookToken)) };
  }

  private async wait(caller: TerminalView, params: Params): Promise<unknown> {
    const target = this.target(caller, params, false);
    const timeout = optionalInt(params, "timeout_ms", DEFAULT_WAIT_MS, 1000, MAX_WAIT_MS);
    const nextTurn = optionalBool(params, "next_turn");
    const until = parseUntil(params.until);
    const since = Date.now();
    const status = await this.waitFor(
      () => {
        const session = this.plugin.agentSessionStore.get(target.hookToken);
        const now = this.plugin.findTerminalView(target.hookToken) ? publicStatus(session) : "ended";
        if (nextTurn) {
          if (now === "blocked" || now === "ended") return now;
          const ended = session?.lastTurnEndedAt ?? 0;
          return ended >= since && now !== "working" ? now : null;
        }
        return until.includes(now) ? now : null;
      },
      timeout,
      true,
      `${target.publicId} is still ${publicStatus(this.plugin.agentSessionStore.get(target.hookToken))}`
    );
    return { id: target.publicId, status };
  }

  private result(caller: TerminalView, params: Params): unknown {
    const target = this.target(caller, params, false);
    const session = this.plugin.agentSessionStore.get(target.hookToken);
    return {
      id: target.publicId,
      status: publicStatus(session),
      turn_failed: session?.lastTurnFailed ?? false,
      message: this.results.get(target.hookToken) ?? session?.lastMessage ?? null,
    };
  }

  private async delegate(caller: TerminalView, params: Params): Promise<unknown> {
    const task = requireString(params, "task");
    const name = optionalString(params, "name", 40) ?? task.replace(/\s+/g, " ").slice(0, 32);
    const callerSession = this.plugin.agentSessionStore.get(caller.hookToken);
    const child = await this.openTerminal(caller, {
      command: "claude",
      prompt: task,
      cwd: callerSession?.cwd ?? caller.shellCwd ?? undefined,
      label: name,
      placement: optionalChoice(params, "placement", PLACEMENTS, "tab"),
    });
    this.plugin.delegationStore.add({
      childToken: child.hookToken,
      parentToken: caller.hookToken,
      task,
      parentLabel: caller.getDisplayText(),
      childLabel: child.getDisplayText(),
      createdAt: Date.now(),
      autoReturn: true,
    });
    return { ...this.describe(child, caller), returns_result: true };
  }

  // ---- Shared ----

  /** The terminals the caller may see and reach: its own group's. */
  private scope(caller: TerminalView): TerminalView[] {
    return this.plugin.groups.terminalsIn(caller.groupId);
  }

  private target(caller: TerminalView, params: Params, allowSelf: boolean): TerminalView {
    const id = requireString(params, "id", 20);
    const target = this.scope(caller).find((view) => view.publicId === id);
    if (!target) throw new ApiError("not_found", `No terminal ${id} in your group. "list" shows the ones you can reach.`, 404);
    if (!allowSelf && target === caller) throw new ApiError("invalid_params", "That's your own terminal");
    return target;
  }

  private describe(view: TerminalView, caller: TerminalView): Record<string, unknown> {
    const session = this.plugin.agentSessionStore.get(view.hookToken);
    const openedBy = this.opened.get(view.hookToken)?.by;
    return {
      id: view.publicId,
      name: view.getDisplayText(),
      self: view === caller,
      status: publicStatus(session),
      status_line: this.statusLine(view.hookToken),
      opened_by: openedBy ? (this.plugin.findTerminalView(openedBy)?.publicId ?? null) : null,
    };
  }

  /** Why the caller may not open another terminal, or null when it may. */
  private openRefusal(caller: TerminalView): string | null {
    if ((this.opened.get(caller.hookToken)?.depth ?? 0) >= MAX_OPEN_DEPTH) {
      return "A terminal opened by an agent can't open more terminals";
    }
    const max = this.plugin.settings.agentControl.maxOpenedTerminals;
    const live = [...this.opened].filter(([token, record]) => record.by === caller.hookToken && this.plugin.findTerminalView(token)).length;
    if (live >= max) return `You already have ${live} terminals open (the limit is ${max}); close one first`;
    return null;
  }

  private async openTerminal(
    caller: TerminalView,
    spec: { command: string; prompt?: string; cwd?: string; label: string; placement: (typeof PLACEMENTS)[number] }
  ): Promise<TerminalView> {
    const refusal = this.openRefusal(caller);
    if (refusal) throw new ApiError("limit", refusal, 429);
    this.takeAction(caller);
    const { workspace } = this.plugin.app;
    // Opening a terminal makes it active; the user goes back to whatever
    // they were doing, since the agent asked for it, not them.
    const previous: WorkspaceLeaf | null = workspace.getMostRecentLeaf();
    const child = await this.plugin.groups.newTerminal(
      caller.groupId,
      false,
      {
        command: spec.command,
        prompt: spec.prompt,
        submit: spec.prompt !== undefined,
        cwd: spec.cwd,
        name: `${caller.getDisplayText()} › ${spec.label}`,
      },
      spec.placement
    );
    if (previous && previous !== child?.leaf) workspace.setActiveLeaf(previous, { focus: true });
    if (!child) throw new ApiError("unavailable", "The terminal couldn't be opened", 500);
    this.opened.set(child.hookToken, { by: caller.hookToken, depth: (this.opened.get(caller.hookToken)?.depth ?? 0) + 1 });
    new Notice(`Terminus: ${caller.getDisplayText()} opened ${child.getDisplayText()}`);
    return child;
  }

  private refuseBypass(command: string): void {
    const flag = bypassFlagIn(command);
    if (flag) throw new ApiError("forbidden", `Terminus doesn't let agents start anything with ${flag}`, 403);
  }

  private takeAction(caller: TerminalView): void {
    if (!this.actions.take(caller.hookToken)) {
      throw new ApiError("rate_limited", `Too many actions: at most ${ACTION_LIMIT} opens, runs, prompts and delegations per 10 minutes`, 429);
    }
  }

  /**
   * Resolves with `check()`'s first non-null value. Checked at once, then
   * on every session change (when `onSessionChange`) and on a timer.
   * Rejects with a timeout, or with whatever `check` throws.
   */
  private waitFor<T>(check: () => T | null, timeoutMs: number, onSessionChange: boolean, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const store = this.plugin.agentSessionStore;
      let interval = 0;
      let timer = 0;
      const finish = (): void => {
        window.clearInterval(interval);
        window.clearTimeout(timer);
        if (onSessionChange) store.off("change", poll);
      };
      const poll = (): void => {
        try {
          const value = check();
          if (value === null) return;
          finish();
          resolve(value);
        } catch (err) {
          finish();
          reject(err);
        }
      };
      interval = window.setInterval(poll, onSessionChange ? 1000 : OUTPUT_POLL_MS);
      timer = window.setTimeout(() => {
        finish();
        reject(new ApiError("timeout", `${timeoutMessage} after ${Math.round(timeoutMs / 1000)}s; call again to keep waiting`, 408));
      }, timeoutMs);
      if (onSessionChange) store.on("change", poll);
      poll();
    });
  }

  private onSessionChange(session: AgentSession): void {
    if (session.status !== "working") {
      if (this.statusLines.delete(session.token)) this.plugin.refreshTerminusViews();
    }
    if (!session.running && !this.plugin.findTerminalView(session.token)) {
      this.results.delete(session.token);
      this.actions.forget(session.token);
    }
    this.returnDelegatedResult(session);
  }

  /**
   * A task an agent delegated (`delegate`) sends its result back on its
   * own: once the new session's first turn is over, the result is queued
   * for the agent that asked, which gets it as soon as it's between turns.
   */
  private returnDelegatedResult(session: AgentSession): void {
    const delegation = this.plugin.delegationStore.get(session.token);
    if (!delegation?.autoReturn || session.status === "working" || session.lastTurnEndedAt === null) return;
    if (publicStatus(session) === "blocked") return;
    const parent = this.plugin.findTerminalView(delegation.parentToken);
    const child = this.plugin.findTerminalView(session.token);
    if (!parent) return;
    const result = this.results.get(session.token) ?? session.lastMessage ?? "(no message)";
    const childName = child ? `${child.getDisplayText()} (${child.publicId})` : delegation.childLabel;
    const outcome = session.lastTurnFailed ? "stopped with an error" : "finished";
    const text = `${childName} ${outcome} the task you delegated: ${delegation.task.replace(/\s+/g, " ")}\n\nIts result:\n\n${result}`;
    this.plugin.delegationStore.remove(session.token);
    this.plugin.queueGuidance(delegation.parentToken, text);
  }
}

function parseRequest(request: unknown): { method: string; params: Params } {
  const body = asParams(request);
  if (typeof body.method !== "string" || !body.method) throw new ApiError("invalid_request", 'The request needs a "method"');
  return { method: body.method, params: asParams(body.params) };
}

function parseUntil(value: unknown): PublicStatus[] {
  if (value === undefined || value === null) return ["done", "idle", "blocked", "ended"];
  const list = Array.isArray(value) ? value : [value];
  const statuses = list.filter((s): s is PublicStatus => typeof s === "string" && (WAITABLE_STATUSES as string[]).includes(s));
  if (statuses.length === 0 || statuses.length !== list.length) {
    throw new ApiError("invalid_params", `"until" takes: ${WAITABLE_STATUSES.join(", ")}`);
  }
  return statuses;
}
