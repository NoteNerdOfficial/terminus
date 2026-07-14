// PreToolUse hook payload shapes, empirically captured from a real
// `claude` 2.1.207 process (see the Phase 0 spike) -- do not hand-guess
// these, they were verified against real stdin payloads.

export interface PreToolUseHookPayloadBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt_id: string;
  permission_mode: string;
  hook_event_name: "PreToolUse";
  tool_use_id: string;
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

// Our PreToolUse hook matcher is exactly "Edit|Write|NotebookEdit" (see
// provisionSettings.ts), so this union is intentionally closed to those
// three -- Claude Code will never invoke our hook for any other tool.
export type PreToolUseHookPayload =
  | (PreToolUseHookPayloadBase & { tool_name: "Edit"; tool_input: EditToolInput })
  | (PreToolUseHookPayloadBase & { tool_name: "Write"; tool_input: WriteToolInput })
  | (PreToolUseHookPayloadBase & { tool_name: "NotebookEdit"; tool_input: NotebookEditToolInput });
