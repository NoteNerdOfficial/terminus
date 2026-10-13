#!/usr/bin/env bash
# Session-event hook bridge for the Terminus Obsidian plugin.
#
# One bridge for the hooks the Multi-agent experience adds on top of the
# three Classic ones: SessionStart, SessionEnd and UserPromptSubmit, and,
# while subagents are tracked, the lead's Agent tool call (PreToolUse),
# SubagentStart and SubagentStop. Each payload carries its own
# hook_event_name, so they share a script and a route (/session-event)
# rather than one of each. Only installed while the Multi-agent experience
# is selected (see provisionSettings.ts).
#
# The Agent call goes here rather than to hook-bridge.sh because it edits no
# file: there's no snapshot to take, only the subagent's task description.
#
# Same environment contract as the other bridges: runs as a subprocess of
# the shell inside a Terminus PTY panel, so it inherits TERMINUS_HOOK_PORT
# and TERMINUS_HOOK_TOKEN from it, and does nothing at all outside one.
#
# Always exits 0, and never writes anything to stdout: SessionStart's and
# UserPromptSubmit's stdout is added to Claude's context, and a status
# update has no business putting anything there. An unreachable review
# server just means this one event goes unrecorded.
set -u

INPUT="$(cat)"

if [ -z "${TERMINUS_HOOK_TOKEN:-}" ] || [ -z "${TERMINUS_HOOK_PORT:-}" ]; then
  exit 0
fi

curl -s -m 5 -o /dev/null \
  -X POST "http://127.0.0.1:${TERMINUS_HOOK_PORT}/session-event" \
  -H "Authorization: Bearer ${TERMINUS_HOOK_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "$INPUT" \
  2>/dev/null

exit 0
