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
import signal
import struct
import sys
import termios
import time

# How often the proxy loop wakes up even with no terminal I/O, purely to
# check whether it should exit (see `terminating` below). Also bounds how
# long it takes to notice the parent has died.
IDLE_POLL_SECONDS = 1.0


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
    #
    # If the Node/Electron parent quits gracefully it sends SIGTERM, caught
    # below. But if Obsidian is force-quit or crashes, we're never signaled
    # at all -- the OS just reparents us to launchd/init and we'd otherwise
    # proxy a shell forever, which is exactly the orphaned-process pile-up
    # this helper used to cause. `terminating` covers both: a caught signal
    # sets it directly, and the idle-poll branch below sets it once our own
    # getppid() no longer matches the parent we started under.
    parent_pid = os.getppid()
    terminating = False

    def _request_shutdown(_signum, _frame):
        nonlocal terminating
        terminating = True

    # A caught signal alone wouldn't wake a blocked select() until it next
    # times out (up to IDLE_POLL_SECONDS later) -- noticeable as a stall
    # every time a terminal tab is closed, versus the instant kill this
    # helper had before it caught SIGTERM at all. set_wakeup_fd makes the
    # C-level signal delivery itself write a byte to wake_r/wake_w, which
    # is in the select() read set below, so shutdown is immediate again.
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)

    signal.signal(signal.SIGTERM, _request_shutdown)
    signal.signal(signal.SIGHUP, _request_shutdown)

    set_winsize(master_fd, args.rows, args.cols)
    write_control({"type": "ready"})

    control_buf = b""
    exit_code = None
    try:
        while not terminating:
            try:
                readable, _, _ = select.select(
                    [0, master_fd, 3, wake_r], [], [], IDLE_POLL_SECONDS
                )
            except InterruptedError:
                continue

            if not readable:
                if os.getppid() != parent_pid:
                    break
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
                if not chunk:
                    # EOF: the parent's write end closed, which only
                    # happens when it's shutting down (or the kernel
                    # force-closed it on a crash/force-quit). Previously
                    # this was silently ignored, and since a closed pipe
                    # is permanently select()-readable, the loop spun at
                    # full CPU forever instead of exiting -- the actual
                    # cause of orphaned pty_helper processes pegging the
                    # CPU rather than just idling.
                    break
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
        # Closing master_fd is what actually delivers the kernel's normal
        # PTY-hangup SIGHUP to the shell's foreground process group -- it
        # can't be deferred to implicit cleanup on process exit, since
        # we're still inside this function (about to block in waitpid)
        # when we reach here from the signal/orphan-detection exit paths,
        # as opposed to the ordinary case where the shell already exited
        # and closed its end first.
        try:
            os.close(master_fd)
        except OSError:
            pass

        exit_code = None
        status = None
        waited_pid = 0
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                waited_pid, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                waited_pid = pid
                break
            if waited_pid != 0:
                break
            time.sleep(0.05)

        if waited_pid == 0:
            # The shell (or something it left running in the foreground)
            # didn't respond to the hangup within the grace period. Force
            # it rather than block here indefinitely -- that would just
            # trade "orphaned and spinning" for "orphaned and stuck".
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                _, status = os.waitpid(pid, 0)
            except ChildProcessError:
                status = None

        if status is not None:
            try:
                exit_code = os.waitstatus_to_exitcode(status)
            except ValueError:
                pass

        try:
            write_control({"type": "exited", "code": exit_code})
        except OSError:
            pass


if __name__ == "__main__":
    main()
