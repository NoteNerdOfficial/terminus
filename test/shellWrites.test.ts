import { describe, it } from "node:test";
import assert from "node:assert";
import { parseShellWriteTargets } from "../src/server/shellWrites";

/**
 * Which files a Bash command looks like it writes. The cases below are the
 * shapes Claude actually produces -- the heredoc ones are copied verbatim
 * from a real session that wrote four notes and had none of them reach the
 * review panel, which is what this parser exists to fix.
 */

const CWD = "/vault";
const HOME = "/Users/me";
const targets = (command: string, cwd = CWD) => parseShellWriteTargets(command, cwd, HOME);

describe("shell write targets: redirections", () => {
  it("finds a plain overwrite", () => {
    assert.deepEqual(targets("echo hi > note.md"), ["/vault/note.md"]);
  });

  it("finds an append", () => {
    assert.deepEqual(targets("echo hi >> log.txt"), ["/vault/log.txt"]);
  });

  it("finds a clobbering and an fd-prefixed redirect", () => {
    assert.deepEqual(targets("echo hi >| a.txt"), ["/vault/a.txt"]);
    assert.deepEqual(targets("build 2> err.log"), ["/vault/err.log"]);
    assert.deepEqual(targets("build &> all.log"), ["/vault/all.log"]);
  });

  it("works with no space before the path", () => {
    assert.deepEqual(targets("echo hi >note.md"), ["/vault/note.md"]);
  });

  it("ignores reads", () => {
    assert.deepEqual(targets("sort < input.txt"), []);
    assert.deepEqual(targets("grep -q x <<< \"$body\""), []);
  });

  it("ignores the shell's own sinks", () => {
    assert.deepEqual(targets("noisy > /dev/null 2> /dev/null"), []);
  });
});

describe("shell write targets: heredocs", () => {
  it("finds the note a heredoc creates, not its body", () => {
    const command = `cd "/Users/me/Documents/Notes/00_Inbox" && cat > "The second draft is the real first draft.md" <<'EOF'
---
date: 2026-10-21
---

# The second draft

Some body text with a > character and a 'quote' and a | pipe.
EOF`;
    assert.deepEqual(targets(command), [
      "/Users/me/Documents/Notes/00_Inbox/The second draft is the real first draft.md",
    ]);
  });

  it("follows the cd into a path with a space", () => {
    const command = `cd "/Users/me/Documents/Acme Notes" && cat > "Reference/Keyboard shortcuts.md" <<'EOF'
# Keyboard shortcuts
EOF`;
    assert.deepEqual(targets(command), [
      "/Users/me/Documents/Acme Notes/Reference/Keyboard shortcuts.md",
    ]);
  });

  it("does not read a body line that merely looks like the delimiter", () => {
    const command = `cat > a.md <<'EOF'
not EOF yet
EOF
echo after > b.md`;
    assert.deepEqual(targets(command), ["/vault/a.md", "/vault/b.md"]);
  });

  it("handles an unquoted and a tab-stripping delimiter", () => {
    assert.deepEqual(targets("cat > a.md <<EOF\nbody\nEOF"), ["/vault/a.md"]);
    assert.deepEqual(targets("cat > a.md <<-END\n\tbody\n\tEND"), ["/vault/a.md"]);
  });

  it("keeps the second of two heredocs on one line apart", () => {
    const command = `cat > a.md <<'A' && cat > b.md <<'B'
first > body
A
second > body
B`;
    assert.deepEqual(targets(command), ["/vault/a.md", "/vault/b.md"]);
  });
});

describe("shell write targets: commands that write their arguments", () => {
  it("finds tee's files, appending or not", () => {
    assert.deepEqual(targets("echo hi | tee a.md b.md"), ["/vault/a.md", "/vault/b.md"]);
    assert.deepEqual(targets("echo hi | tee -a a.md"), ["/vault/a.md"]);
  });

  it("finds sed's file only in place, and never its script", () => {
    assert.deepEqual(targets("sed -i '' 's/a/b/' note.md"), ["/vault/note.md"]);
    assert.deepEqual(targets("sed -i.bak 's/a/b/' note.md"), ["/vault/note.md"]);
    assert.deepEqual(targets("sed 's/a/b/' note.md"), []);
  });

  it("finds a copy's destination, not its source", () => {
    assert.deepEqual(targets("cp a.md b.md"), ["/vault/b.md"]);
    assert.deepEqual(targets("mv a.md b.md"), ["/vault/b.md"]);
  });

  it("finds touch and rm targets", () => {
    assert.deepEqual(targets("touch a.md b.md"), ["/vault/a.md", "/vault/b.md"]);
    assert.deepEqual(targets("rm -f stale.md"), ["/vault/stale.md"]);
  });

  it("reads a command through its full path", () => {
    assert.deepEqual(targets("/usr/bin/touch a.md"), ["/vault/a.md"]);
  });

  it("ignores a command that only reads", () => {
    assert.deepEqual(targets("cat note.md"), []);
    assert.deepEqual(targets("ls -la && grep -r foo ."), []);
  });
});

describe("shell write targets: resolution", () => {
  it("carries a cd across later segments", () => {
    assert.deepEqual(targets("cd sub; echo hi > a.md"), ["/vault/sub/a.md"]);
  });

  it("leaves an absolute path alone and normalizes it", () => {
    assert.deepEqual(targets("echo hi > /tmp/x/../a.md"), ["/tmp/a.md"]);
  });

  it("expands a leading tilde", () => {
    assert.deepEqual(targets("echo hi > ~/notes/a.md"), ["/Users/me/notes/a.md"]);
  });

  it("skips a word it would have to run a shell to resolve", () => {
    assert.deepEqual(targets('echo hi > "$TARGET"'), []);
    assert.deepEqual(targets("echo hi > *.md"), []);
    assert.deepEqual(targets("echo hi > $(date +%F).md"), []);
  });

  it("reports each file once", () => {
    assert.deepEqual(targets("echo a > n.md && echo b >> n.md"), ["/vault/n.md"]);
  });

  it("ignores leading environment assignments", () => {
    assert.deepEqual(targets("FOO=bar touch a.md"), ["/vault/a.md"]);
  });
});
