// PreToolUse hook payload shapes, empirically captured from a real
// `claude` 2.1.207 process (see the Phase 0 spike) -- do not hand-guess
// these, they were verified against real stdin payloads.

export interface PreToolUseHookPayloadBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  /** The user turn this call belongs to. Captured from 2.1.304: one id
   *  covers a whole turn, across every API request inside it, and a
   *  subagent's call carries its LEAD's id -- so this is what ties a file
   *  change back to the request that caused it, for the lead and its
   *  subagents alike. UserPromptSubmit and Stop carry the same id. */
  prompt_id: string;
  permission_mode: string;
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_use_id: string;
  /** Present only when a subagent made the call (captured from 2.1.296);
   *  the lead session's own calls carry neither. */
  agent_id?: string;
  agent_type?: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface NotebookEditToolInput {
  notebook_path: string;
  cell_id: string;
  new_source: string;
  cell_type?: string;
  edit_mode?: string;
}

export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
}

// The file-editing tools, whose payload alone says what the change is:
// hook-bridge.sh posts one of these and the pre-edit snapshot is taken on
// the spot (see server/diff.ts). Bash is handled separately below, since a
// command's effect isn't knowable until it has run.
export type PreToolUseHookPayload =
  | (PreToolUseHookPayloadBase & { tool_name: "Edit"; tool_input: EditToolInput })
  | (PreToolUseHookPayloadBase & { tool_name: "Write"; tool_input: WriteToolInput })
  | (PreToolUseHookPayloadBase & { tool_name: "NotebookEdit"; tool_input: NotebookEditToolInput })
  | BashToolHookPayload;

/**
 * Bash, on the same bridge as the three file tools but matched on both
 * PreToolUse and PostToolUse -- a shell write is only reviewable as the
 * difference between the two. Pre snapshots the files the command looks
 * like it will write (see server/shellWrites.ts), Post re-reads them and
 * records whatever actually changed. Both carry the same tool_use_id, which
 * is what pairs them. Captured from Claude Code 2.1.312.
 */
export interface BashToolHookPayload extends PreToolUseHookPayloadBase {
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_name: "Bash";
  tool_input: BashToolInput;
  /** PostToolUse only; a non-zero exit still reports what it wrote. */
  tool_response?: {
    stdout?: string;
    stderr?: string;
    interrupted?: boolean;
  };
}

/** The three file-editing tools alone -- what buildDiff can turn into a
 *  diff from the payload by itself. */
export type FileToolHookPayload = Exclude<PreToolUseHookPayload, BashToolHookPayload>;

/** Whether this payload is the Bash pair rather than a file tool's own. */
export function isBashPayload(payload: PreToolUseHookPayload): payload is BashToolHookPayload {
  return payload.tool_name === "Bash";
}

// Session-level hook payloads. SessionStart, SessionEnd, UserPromptSubmit
// and Stop were captured from a real `claude` 2.1.296 run; Notification
// fires only interactively; an idle_prompt one was captured from a live
// 2.1.296 session (message + notification_type), and its fields beyond the
// common ones are optional and taken from Claude Code's hook docs.

interface SessionHookPayloadBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

export interface SessionStartHookPayload extends SessionHookPayloadBase {
  hook_event_name: "SessionStart";
  /** "startup", "resume", "clear" or "compact". */
  source: string;
  /** The custom agent the whole session runs as (`claude --agent reviewer`,
   *  or the `agent` setting). Every later event carries it too, with no
   *  agent_id on the session's own. Captured from 2.1.296. */
  agent_type?: string;
}

export interface SessionEndHookPayload extends SessionHookPayloadBase {
  hook_event_name: "SessionEnd";
  /** e.g. "clear", "logout", "prompt_input_exit", "other". */
  reason: string;
}

export interface UserPromptSubmitHookPayload extends SessionHookPayloadBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
  /** The turn this prompt opens, matching the prompt_id on the edits it
   *  causes and on its Stop (captured from 2.1.304) -- so the prompt text
   *  can be joined to them without guessing from event order. */
  prompt_id: string;
}

// Subagent payloads, captured from a real 2.1.296 run with both background
// and foreground subagents.

/** The lead's PreToolUse for the Agent tool (matcher "Agent|Task", on the
 *  session-event bridge rather than hook-bridge.sh: it edits no file, so
 *  there's no snapshot to take). The only place a subagent's task
 *  description appears before it finishes. */
export interface AgentToolHookPayload extends SessionHookPayloadBase {
  hook_event_name: "PreToolUse";
  tool_name: "Agent" | "Task";
  tool_use_id: string;
  tool_input: {
    description?: string;
    subagent_type?: string;
    run_in_background?: boolean;
    /** Set when the call spawns an agent-team teammate; the teammate's
     *  SubagentStart then has this as its agent_type (2.1.296). */
    name?: string;
  };
}

export interface SubagentStartHookPayload extends SessionHookPayloadBase {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
}

/** One of the session's background tasks, as SubagentStop lists them --
 *  including the subagent that's stopping. Foreground subagents aren't
 *  listed. */
export interface BackgroundTask {
  id: string;
  type: string;
  status?: string;
  description?: string;
  agent_type?: string;
}

/** Also sent, with an empty agent_type and no SubagentStart before it, for
 *  Claude Code's own internal helpers (captured from 2.1.296); those aren't
 *  subagents the user started. */
export interface SubagentStopHookPayload extends SessionHookPayloadBase {
  hook_event_name: "SubagentStop";
  agent_id: string;
  agent_type: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
  background_tasks?: BackgroundTask[];
}

/** What the session-event bridge forwards (see session-event-bridge.sh). */
export type SessionEventHookPayload =
  | SessionStartHookPayload
  | SessionEndHookPayload
  | UserPromptSubmitHookPayload
  | AgentToolHookPayload
  | SubagentStartHookPayload
  | SubagentStopHookPayload
  | StopFailureHookPayload;

export interface StopHookPayload extends SessionHookPayloadBase {
  hook_event_name: "Stop";
  /** The turn that just ended; see PreToolUseHookPayloadBase.prompt_id. */
  prompt_id: string;
  stop_hook_active: boolean;
  last_assistant_message?: string;
  /** Background tasks still running as the turn ends; see BackgroundTask. */
  background_tasks?: BackgroundTask[];
}

/** Sent instead of Stop or SubagentStop when a turn ends in an error (an
 *  API error such as model_not_found, captured from 2.1.296). With
 *  agent_id it's a subagent that failed; without, the lead's turn. */
export interface StopFailureHookPayload extends SessionHookPayloadBase {
  hook_event_name: "StopFailure";
  /** The turn that failed. Optional: Stop carries one (captured from
   *  2.1.304) but no StopFailure has been captured to confirm it does too,
   *  so callers fall back to closing whichever turn is open. */
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  /** An error code, e.g. "model_not_found". */
  error?: string;
  /** The readable error message. */
  last_assistant_message?: string;
}

export interface NotificationHookPayload extends SessionHookPayloadBase {
  hook_event_name: "Notification";
  message?: string;
  /** e.g. "permission_prompt" or "idle_prompt". */
  notification_type?: string;
}
