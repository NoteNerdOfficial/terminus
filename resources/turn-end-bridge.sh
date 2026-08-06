#!/usr/bin/env bash
# Stop hook bridge for the Terminus Obsidian plugin.
#
# Companion to hook-bridge.sh. That one fires per file write (PreToolUse) and
# is what raises the "Claude is editing X" chip in the terminal's header; this
# one fires once when Claude finishes its turn, and is what lowers it again.
#
# Without this, the chip has no end-of-turn signal to wait on and has to guess
# with a timer -- which either drops it while Claude is still mid-turn (just
# thinking, or running tools that aren't writes) or leaves it up long after the
# turn is over. The Stop hook is that signal.
#
# Same environment contract as hook-bridge.sh: runs as a subprocess of the
# shell inside a Terminus PTY panel, so it inherits TERMINUS_HOOK_PORT and
# TERMINUS_HOOK_TOKEN from it, and does nothing at all outside one.
#
# Always exits 0, and never writes anything to stdout: a Stop hook's stdout is
# how a hook tells Claude Code to *block* stopping, and a status chip has no
# business doing that. An unreachable review server just means the chip clears
# on its own fallback timer instead.
set -u

# Claude Code writes the hook payload to stdin. Drained and discarded rather
# than left unread -- nothing here needs it, and not reading it risks handing
# the writer an EPIPE on a pipe no one ever consumed.
cat >/dev/null

if [ -z "${TERMINUS_HOOK_TOKEN:-}" ] || [ -z "${TERMINUS_HOOK_PORT:-}" ]; then
  exit 0
fi

curl -s -m 5 -o /dev/null \
  -X POST "http://127.0.0.1:${TERMINUS_HOOK_PORT}/turn-end" \
  -H "Authorization: Bearer ${TERMINUS_HOOK_TOKEN}" \
  2>/dev/null

exit 0
