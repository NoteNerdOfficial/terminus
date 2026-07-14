import { pathBasename, pathJoin } from "../node/fs";

/**
 * Computes env vars that tell pty_helper.py's build_child_env() to
 * redirect the *exec'd shell's* startup-file lookup to our own injected rc
 * files (see resources/shell-integration/), which chain-load the user's
 * real config and then add OSC 133 command-boundary hooks. This happens
 * during shell *startup* (before it starts reading interactive input), so
 * there's no visible injected command like there would be if we tried to
 * `pty.write()` a `source ...` line after the shell was already up.
 *
 * Deliberately named TERMINUS_CHILD_* rather than ZDOTDIR/HOME
 * directly: those get applied only to the environment of the exec'd child
 * shell (by pty_helper.py, right before exec), never to this whole
 * process's own env. pty_helper.py is a long-lived Python process -- if
 * its own env carried a fake HOME for its whole lifetime, anything it (or
 * the Python runtime) does that resolves `~`/$HOME would write into the
 * fake directory instead of the user's real home, which is exactly what
 * happened during development (a real .bash_history and a Python bytecode
 * cache tree leaked into this plugin's own resources folder).
 *
 * Unsupported shells (fish, etc.) get an empty object back: no
 * integration, but the terminal still works as a plain terminal.
 */
export function getShellIntegrationEnv(shellPath: string, pluginResourcesDir: string): Record<string, string> {
  const shellName = pathBasename(shellPath);

  if (shellName === "zsh") {
    return {
      TERMINUS_CHILD_ZDOTDIR: pathJoin(pluginResourcesDir, "shell-integration", "zsh"),
    };
  }

  if (shellName === "bash") {
    return {
      TERMINUS_CHILD_HOME: pathJoin(pluginResourcesDir, "shell-integration", "bash"),
    };
  }

  return {};
}
