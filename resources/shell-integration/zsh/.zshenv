# Terminus shell integration (zsh).
#
# We hijack ZDOTDIR so zsh looks here for .zshenv, which is the ONLY rc file
# zsh unconditionally reads (before it knows if it's a login/interactive
# shell). This file immediately restores ZDOTDIR to the user's real value,
# so zsh's subsequent lookups (.zprofile, .zshrc, .zlogin) go straight to
# the user's actual files -- we never need fake versions of those.

if [[ -n "${TERMINUS_ORIG_ZDOTDIR:-}" ]]; then
  export ZDOTDIR="$TERMINUS_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset TERMINUS_ORIG_ZDOTDIR

# We hijacked the one .zshenv lookup zsh would have made -- it won't look
# for it again, so source the user's real one manually now.
if [[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  source "${ZDOTDIR:-$HOME}/.zshenv"
fi

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
}
__rt_preexec() {
  printf '\033]133;C\007'
}

if autoload -Uz add-zsh-hook 2>/dev/null; then
  add-zsh-hook precmd __rt_precmd
  add-zsh-hook preexec __rt_preexec
fi
