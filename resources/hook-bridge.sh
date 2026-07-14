#!/usr/bin/env bash
# PreToolUse hook bridge for the Terminus Obsidian plugin.
#
# Claude Code invokes this script (via a project-scoped .claude/settings.local.json
# hooks.PreToolUse entry) as a subprocess of whatever shell is running inside a
# Terminus PTY panel, so it inherits TERMINUS_HOOK_PORT and
# TERMINUS_HOOK_TOKEN from that shell's environment.
#
# This does NOT gate the write on a human decision -- Claude is allowed to
# complete its whole turn uninterrupted, and review happens afterwards in the
# Pending Changes panel (Accept = keep, Reject = revert the file). This
# script's only job is to notify the plugin's local server of the change
# (which reads the pre-edit file content for later revert) before the write
# happens, then always let the write proceed.
#
# Always exits 0: a crashed/unreachable review server should never block
# Claude from working, it just means that edit won't show up for review.
set -u

INPUT="$(cat)"

if [ -z "${TERMINUS_HOOK_TOKEN:-}" ] || [ -z "${TERMINUS_HOOK_PORT:-}" ]; then
  exit 0
fi

curl -s -m 10 -o /dev/null \
  -X POST "http://127.0.0.1:${TERMINUS_HOOK_PORT}/review" \
  -H "Authorization: Bearer ${TERMINUS_HOOK_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "$INPUT" 2>/dev/null \
  || echo "Terminus: could not reach review server -- proceeding without recording this change for review." >&2

exit 0
