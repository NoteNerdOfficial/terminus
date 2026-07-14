#!/usr/bin/env python3
"""PTY proxy helper for the Terminus Obsidian plugin.

Allocates a real pseudo-terminal, execs the given shell inside it, and
proxies bytes between the PTY and this process's own stdio so a Node/Electron
parent (which cannot allocate a PTY without a native addon) can drive a real
interactive shell using nothing but child_process.spawn + pipes.

Framing, fixed by contract with the Node-side PtyProcess class:
  fd0 (stdin)  -- raw bytes typed by the user, written verbatim to the PTY.
  fd1 (stdout) -- raw bytes read from the PTY, written verbatim for the parent
                  to feed into xterm.js.
  fd2 (stderr) -- this helper's own diagnostics only (e.g. exec failures).
  fd3          -- newline-delimited JSON control channel, kept separate from
                  fd0/fd1 so arbitrary binary terminal traffic can never be
                  mistaken for a control message.
                    Node -> helper : {"type": "resize", "cols": N, "rows": N}
                    helper -> Node : {"type": "ready"}
                    helper -> Node : {"type": "exited", "code": N|null}
"""
import argparse
import fcntl
import json
import os
import pty
import select
import struct
import sys
import termios


def set_winsize(fd, rows, cols):
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def write_control(obj):
    line = (json.dumps(obj) + "\n").encode("utf-8")
    os.write(3, line)


def build_child_env():
    """Constructs the exec'd shell's environment from a copy of this
    process's own (untouched, correct) environment, applying the
    ZDOTDIR/HOME shell-integration redirect ONLY to that copy.

    This process's OWN env must never carry TERMINUS_CHILD_HOME as
    its real HOME -- it's a long-lived Python process, and anything it (or
    the Python runtime itself) does that resolves `~`/$HOME during its
    lifetime would otherwise write into the fake shell-integration
    directory instead of the user's real home. That's not hypothetical: an
    earlier version of this override applied to the whole process and did
    exactly that, leaking a real .bash_history and a Python bytecode cache
    tree into the plugin's own resources folder during testing.
    """
    env = dict(os.environ)
    child_zdotdir = env.pop("TERMINUS_CHILD_ZDOTDIR", None)
    child_home = env.pop("TERMINUS_CHILD_HOME", None)
    if child_zdotdir:
        env["TERMINUS_ORIG_ZDOTDIR"] = env.get("ZDOTDIR", "")
        env["ZDOTDIR"] = child_zdotdir
    if child_home:
        env["TERMINUS_ORIG_HOME"] = env.get("HOME", "")
        env["HOME"] = child_home
    return env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--shell", default=os.environ.get("SHELL", "/bin/zsh"))
    args = parser.parse_args()

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: become the interactive login shell. -l -i is load-bearing --
        # it makes the shell re-source .zprofile/.bash_profile and rebuild its
        # own PATH, independent of whatever minimal PATH the Electron parent
        # (launched from Finder/Dock) inherited.
        try:
            os.execvpe(args.shell, [args.shell, "-l", "-i"], build_child_env())
        except OSError as exc:
            sys.stderr.write(f"Terminus: failed to exec {args.shell}: {exc}\n")
            os._exit(127)
        return

    # Parent: proxy loop.
    set_winsize(master_fd, args.rows, args.cols)
    write_control({"type": "ready"})

    control_buf = b""
    exit_code = None
    try:
        while True:
            try:
                readable, _, _ = select.select([0, master_fd, 3], [], [])
            except InterruptedError:
                continue

            if master_fd in readable:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                os.write(1, chunk)

            if 0 in readable:
                try:
                    chunk = os.read(0, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    os.write(master_fd, chunk)

            if 3 in readable:
                try:
                    chunk = os.read(3, 65536)
                except OSError:
                    chunk = b""
                if chunk:
                    control_buf += chunk
                    while b"\n" in control_buf:
                        line, control_buf = control_buf.split(b"\n", 1)
                        if not line.strip():
                            continue
                        try:
                            msg = json.loads(line.decode("utf-8"))
                        except ValueError:
                            continue
                        if msg.get("type") == "resize":
                            set_winsize(master_fd, int(msg["rows"]), int(msg["cols"]))
    finally:
        try:
            _, status = os.waitpid(pid, 0)
            exit_code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            exit_code = None
        try:
            write_control({"type": "exited", "code": exit_code})
        except OSError:
            pass


if __name__ == "__main__":
    main()
