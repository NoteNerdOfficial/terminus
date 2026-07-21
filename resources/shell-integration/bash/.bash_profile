# Terminus shell integration (bash).
#
# We hijack HOME so bash (as a login shell, per pty_helper.py's -l flag)
# looks here for .bash_profile. This file immediately restores HOME to the
# user's real value, then chain-loads whichever of .bash_profile/.bash_login
# /.profile the user actually has, matching bash's own normal lookup order.

export HOME="${TERMINUS_ORIG_HOME:-$HOME}"
unset TERMINUS_ORIG_HOME

# bash computes HISTFILE's default (~/.bash_history) from $HOME at its own
# startup, before this script ever runs -- using the fake HOME we're about
# to abandon. Force it back explicitly, or bash's command history for this
# session would otherwise still end up written into the plugin's resources
# folder instead of the user's real home.
export HISTFILE="$HOME/.bash_history"

for __rt_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [[ -f "$__rt_f" ]]; then
    source "$__rt_f"
    break
  fi
done
unset __rt_f

# bash has no native preexec hook, so this uses the well-known DEBUG-trap
# pattern (as popularized by rcaloras/bash-preexec): a guard flag ensures
# the trap -- which fires before EVERY simple command, including ones
# nested inside a compound command -- only emits once per submitted
# command line, reset by PROMPT_COMMAND right before the next prompt draws.
__rt_preexec_armed=1

__rt_preexec() {
  [[ -n "${COMP_LINE:-}" ]] && return   # don't fire during tab-completion
  [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
  [[ "$__rt_preexec_armed" != 1 ]] && return
  __rt_preexec_armed=0
  printf '\033]133;C\007'
}
trap '__rt_preexec' DEBUG

__rt_precmd() {
  local exit_code=$?
  # A foreground program (a fullscreen TUI, Claude Code's own CLI included)
  # can enable DEC private modes -- focus reporting, bracketed paste, mouse
  # tracking -- that are terminal-level state, not tied to that program's
  # lifetime. If it exits (or crashes) without disabling what it turned on,
  # xterm.js keeps honoring the mode against this now-plain shell: e.g. with
  # focus reporting still armed, every later pane/tab focus change writes a
  # raw ESC[I/ESC[O into this shell, which has no handler for it and echoes
  # the bytes back as literal garbage on the input line. Disabling them
  # unconditionally on every fresh prompt (a harmless no-op if already off)
  # guarantees a returned-to shell prompt never inherits stray state from
  # whatever ran before it.
  printf '\033[?1004l\033[?2004l\033[?1000l\033[?1002l\033[?1003l\033[?1006l\033[?1015l\033[?1016l'
  printf '\033]133;D;%d\007' "$exit_code"
  # Custom cwd-tracking channel (OSC 7, plain path -- no file:// wrapping or
  # hostname, since Terminus is the only consumer and parsing that back out
  # would be pure overhead for no benefit here).
  printf '\033]7;%s\007' "$PWD"
  __rt_preexec_armed=1
}
PROMPT_COMMAND="__rt_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
