#!/usr/bin/env bash
# Notification hook bridge for the Terminus Obsidian plugin.
#
# Companion to hook-bridge.sh/turn-end-bridge.sh. Claude Code fires its
# Notification hook when it needs the user's permission to use a tool, or
# when input has sat idle long enough that it's waiting on the user -- both
# are exactly "this terminal needs attention" moments, so any firing of this
# hook is treated as one, without needing to parse the message text. This is
# what raises the blinking dot on the terminal's tab header; onTurnEnd (via
# the Stop hook) and focusing the tab are what lower it again.
#
# Same environment contract as the other two bridges: runs as a subprocess of
# the shell inside a Terminus PTY panel, so it inherits TERMINUS_HOOK_PORT
# and TERMINUS_HOOK_TOKEN from it, and does nothing at all outside one.
#
# Always exits 0, and never writes anything to stdout: like the Stop hook, a
# Notification hook's stdout is how it would block Claude, and this has no
# business doing that. An unreachable review server just means the dot never
# lights up for this particular prompt.
set -u

# Claude Code writes the hook payload to stdin. Forwarded as the request body
# for the session status the Agent inbox shows (the notification's type (permission prompt vs. idle)).
# The server still accepts an empty body, so an older copy of this script
# that discards stdin keeps working.
INPUT="$(cat)"

if [ -z "${TERMINUS_HOOK_TOKEN:-}" ] || [ -z "${TERMINUS_HOOK_PORT:-}" ]; then
  exit 0
fi

curl -s -m 5 -o /dev/null \
  -X POST "http://127.0.0.1:${TERMINUS_HOOK_PORT}/notification" \
  -H "Authorization: Bearer ${TERMINUS_HOOK_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "$INPUT" \
  2>/dev/null

exit 0
