#!/usr/bin/env python3
"""Command-line client for the Terminus agent API.

Runs inside a Terminus terminal, where TERMINUS_HOOK_PORT and
TERMINUS_HOOK_TOKEN say how to reach the plugin and which terminal is
calling. Each subcommand is one POST /api request; the plugin decides what
this terminal may do (see src/agentApi/AgentApi.ts). Standard library only.

Prints the result as JSON on stdout (`read` and `result` print text), or an
error as JSON on stderr with exit status 1. Usage errors exit with 2.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Long waits are bounded by the server; this covers the request itself.
REQUEST_MARGIN_SECONDS = 15


def fail(code, message, status=1):
    sys.stderr.write(json.dumps({"error": {"code": code, "message": message}}) + "\n")
    sys.exit(status)


def call(method, params, wait_seconds=0):
    port = os.environ.get("TERMINUS_HOOK_PORT")
    token = os.environ.get("TERMINUS_HOOK_TOKEN")
    if not port or not token:
        fail("not_in_terminus", "Not running in a Terminus terminal (TERMINUS_HOOK_PORT/TERMINUS_HOOK_TOKEN unset)")
    body = json.dumps({"method": method, "params": {k: v for k, v in params.items() if v is not None}}).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:%s/api" % port,
        data=body,
        method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=wait_seconds + REQUEST_MARGIN_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            payload = json.loads(err.read().decode("utf-8"))
        except ValueError:
            fail("http_%d" % err.code, "Terminus answered with HTTP %d" % err.code)
    except (urllib.error.URLError, OSError) as err:
        fail("unreachable", "Couldn't reach Terminus: %s. Is Obsidian still running?" % err)
    if not isinstance(payload, dict) or not payload.get("ok"):
        error = (payload or {}).get("error") or {}
        fail(error.get("code", "error"), error.get("message", "Unknown error"))
    return payload.get("result")


def ms(seconds):
    return None if seconds is None else int(seconds * 1000)


def add_browser_parser(sub):
    browser = sub.add_parser("browser", help="open and drive a browser for pages on this computer")
    bsub = browser.add_subparsers(dest="browser_command", metavar="ACTION")
    bsub.required = True

    def target(p):
        group = p.add_mutually_exclusive_group(required=True)
        group.add_argument("--path", help="a file or folder in the vault or your working folder")
        group.add_argument("--url", help="a page on this computer, e.g. http://localhost:5173")

    p = bsub.add_parser("open", help="open a browser beside you")
    target(p)
    p.add_argument("--placement", choices=["tab", "split-right", "split-down"])
    bsub.add_parser("list", help="browsers in your group")
    p = bsub.add_parser("navigate", help="open another page")
    p.add_argument("id")
    target(p)
    for name, text in (("back", "go back a page"), ("reload", "reload the page")):
        p = bsub.add_parser(name, help=text)
        p.add_argument("id")
        p.add_argument("--snapshot", action="store_true")
    p = bsub.add_parser("snapshot", help="print the page as text, with refs to act on")
    p.add_argument("id")
    p = bsub.add_parser("click", help="click an element")
    p.add_argument("id")
    p.add_argument("ref")
    p.add_argument("--double", action="store_true")
    p.add_argument("--snapshot", action="store_true", help="print a fresh snapshot after")
    p = bsub.add_parser("type", help="replace a field's text")
    p.add_argument("id")
    p.add_argument("ref")
    p.add_argument("text")
    p.add_argument("--append", action="store_true", help="add to the text instead")
    p.add_argument("--submit", action="store_true", help="press Enter after")
    p.add_argument("--snapshot", action="store_true")
    p = bsub.add_parser("press", help="press a key, such as Enter, Tab or Shift+Tab")
    p.add_argument("id")
    p.add_argument("key")
    p.add_argument("--ref", help="focus this element first")
    p.add_argument("--snapshot", action="store_true")
    p = bsub.add_parser("select", help="pick options in a <select>")
    p.add_argument("id")
    p.add_argument("ref")
    p.add_argument("values", nargs="+")
    p.add_argument("--snapshot", action="store_true")
    p = bsub.add_parser("wait", help="wait for text to appear on the page, or to go")
    p.add_argument("id")
    p.add_argument("--text")
    p.add_argument("--gone")
    p.add_argument("--timeout", type=float, help="seconds (default 30)")
    p = bsub.add_parser("screenshot", help="save a PNG of the page and print its path")
    p.add_argument("id")
    p = bsub.add_parser("console", help="console messages since you last asked")
    p.add_argument("id")
    p.add_argument("--level", choices=["verbose", "info", "warning", "error"])
    p = bsub.add_parser("close", help="close a browser you opened")
    p.add_argument("id")


def print_with_snapshot(result):
    """Prints an action's result as JSON, and its snapshot (if any) as text after it."""
    snapshot = result.pop("snapshot", None) if isinstance(result, dict) else None
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    if snapshot is not None:
        sys.stdout.write(snapshot + "\n")


def run_browser(args):
    a = args.browser_command
    flags = {"snapshot": True} if getattr(args, "snapshot", False) else {}
    if a == "open":
        result = call("browser.open", {"path": args.path, "url": args.url, "placement": args.placement})
    elif a == "list":
        result = call("browser.list", {})
    elif a == "navigate":
        result = call("browser.navigate", {"id": args.id, "path": args.path, "url": args.url})
    elif a in ("back", "reload"):
        result = call("browser." + a, dict({"id": args.id}, **flags))
    elif a == "snapshot":
        result = call("browser.snapshot", {"id": args.id})
        sys.stdout.write("[%s] %s -- %s\n" % (result["id"], result.get("title") or "(untitled)", result.get("shown_as") or result.get("url")))
        sys.stdout.write(result["snapshot"] + "\n")
        return
    elif a == "click":
        result = call("browser.click", dict({"id": args.id, "ref": args.ref, "double": args.double or None}, **flags))
    elif a == "type":
        result = call("browser.type", dict({"id": args.id, "ref": args.ref, "text": args.text, "append": args.append or None, "submit": args.submit or None}, **flags))
    elif a == "press":
        result = call("browser.press", dict({"id": args.id, "key": args.key, "ref": args.ref}, **flags))
    elif a == "select":
        result = call("browser.select", dict({"id": args.id, "ref": args.ref, "values": args.values}, **flags))
    elif a == "wait":
        if args.text is None and args.gone is None:
            fail("invalid_params", "Give --text to wait for, or --gone", 2)
        wait = args.timeout if args.timeout is not None else 30
        result = call("browser.wait", {"id": args.id, "text": args.text, "gone": args.gone, "timeout_ms": ms(args.timeout)}, wait)
    elif a == "screenshot":
        sys.stdout.write(call("browser.screenshot", {"id": args.id})["path"] + "\n")
        return
    elif a == "console":
        result = call("browser.console", {"id": args.id, "level": args.level})
        messages = result.get("messages") or []
        if not messages:
            sys.stdout.write("(no new messages)\n")
        for m in messages:
            where = (" (%s)" % m["source"]) if m.get("source") else ""
            sys.stdout.write("[%s] %s%s\n" % (m["level"], m["text"], where))
        return
    elif a == "close":
        result = call("browser.close", {"id": args.id})
    else:
        fail("usage", "unknown browser action", 2)
        return
    print_with_snapshot(result)


def main():
    parser = argparse.ArgumentParser(prog="terminus", description="Control Terminus from inside one of its terminals.")
    # Not dest="command": that would collide with `open --command`.
    sub = parser.add_subparsers(dest="subcommand", metavar="COMMAND")
    sub.required = True

    sub.add_parser("whoami", help="this terminal's id, name, group and status")
    sub.add_parser("list", help="terminals in your group")

    p = sub.add_parser("open", help="open a terminal in your group")
    p.add_argument("--name")
    p.add_argument("--command", help="run this once the shell is ready")
    p.add_argument("--prompt", help="with an agent --command such as claude: the task to send it")
    p.add_argument("--placement", choices=["tab", "split-right", "split-down"])
    p.add_argument("--cwd")

    p = sub.add_parser("run", help="run a command line in a shell terminal")
    p.add_argument("id")
    p.add_argument("command_line", metavar="command")

    p = sub.add_parser("read", help="print a terminal's recent output")
    p.add_argument("id")
    p.add_argument("--lines", type=int)

    p = sub.add_parser("wait-output", help="wait until a terminal's recent output contains a pattern")
    p.add_argument("id")
    p.add_argument("pattern")
    p.add_argument("--regex", action="store_true")
    p.add_argument("--lines", type=int)
    p.add_argument("--timeout", type=float, help="seconds (default 100)")

    p = sub.add_parser("close", help="close a terminal you opened")
    p.add_argument("id")

    p = sub.add_parser("notify", help="notify the user")
    p.add_argument("body")
    p.add_argument("--title")

    p = sub.add_parser("status", help="say what you're doing, on your inbox card (no text clears it)")
    p.add_argument("text", nargs="?", default="")

    p = sub.add_parser("prompt", help="send a message to another Claude session in your group")
    p.add_argument("id")
    p.add_argument("text")
    p.add_argument("--now", action="store_true", help="type it into the running turn instead of queueing it")

    p = sub.add_parser("wait", help="wait for another session's status")
    p.add_argument("id")
    p.add_argument("--until", action="append", choices=["working", "blocked", "done", "idle", "ended"])
    p.add_argument("--next-turn", action="store_true", help="wait for its next turn to finish")
    p.add_argument("--timeout", type=float, help="seconds (default 100)")

    p = sub.add_parser("result", help="print a session's last message")
    p.add_argument("id")

    p = sub.add_parser("delegate", help="start a new Claude session on a task; its result comes back to you")
    p.add_argument("task")
    p.add_argument("--name")
    p.add_argument("--placement", choices=["tab", "split-right", "split-down"])

    add_browser_parser(sub)

    args = parser.parse_args()
    if args.subcommand == "browser":
        run_browser(args)
        return
    timeout = getattr(args, "timeout", None)
    wait = timeout if timeout is not None else 100
    c = args.subcommand

    if c == "whoami":
        result = call("whoami", {})
    elif c == "list":
        result = call("terminal.list", {})
    elif c == "open":
        result = call("terminal.open", {"name": args.name, "command": args.command, "prompt": args.prompt, "placement": args.placement, "cwd": args.cwd})
    elif c == "run":
        result = call("terminal.run", {"id": args.id, "command": args.command_line})
    elif c == "read":
        sys.stdout.write(call("terminal.read", {"id": args.id, "lines": args.lines})["text"] + "\n")
        return
    elif c == "wait-output":
        result = call("terminal.wait_output", {"id": args.id, "pattern": args.pattern, "regex": args.regex or None, "lines": args.lines, "timeout_ms": ms(timeout)}, wait)
    elif c == "close":
        result = call("terminal.close", {"id": args.id})
    elif c == "notify":
        result = call("notify", {"body": args.body, "title": args.title})
    elif c == "status":
        result = call("status", {"text": args.text})
    elif c == "prompt":
        result = call("agent.prompt", {"id": args.id, "text": args.text, "mode": "steer" if args.now else "queue"})
    elif c == "wait":
        result = call("agent.wait", {"id": args.id, "until": args.until, "next_turn": args.next_turn or None, "timeout_ms": ms(timeout)}, wait)
    elif c == "result":
        result = call("agent.result", {"id": args.id})
        sys.stdout.write("[%s] %s\n" % (result["id"], result["status"]))
        sys.stdout.write((result.get("message") or "(no message yet)") + "\n")
        return
    elif c == "delegate":
        result = call("agent.delegate", {"task": args.task, "name": args.name, "placement": args.placement})
    else:
        parser.error("unknown command")
        return
    sys.stdout.write(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
