import { pathJoin } from "terminus-node-bridge";

/**
 * Which files a Bash command looks like it will write.
 *
 * Our PreToolUse matcher used to be exactly Edit|Write|NotebookEdit, so a
 * note Claude created with `cat > note.md <<'EOF'` never reached the review
 * panel at all -- and Claude reaches for a heredoc routinely. This is what
 * lets a shell write be reviewed like a tool write: the paths found here are
 * snapshotted before the command runs and re-read after it (see
 * TerminalView.onShellCommand), so the row gets a real diff and a Reject
 * that restores exact bytes.
 *
 * Deliberately a guess, and allowed to be a loose one. A path this returns
 * that the command never touches costs nothing: the before/after comparison
 * finds the content identical and no row is recorded. That asymmetry --
 * false positives are free, false negatives are invisible -- is why the
 * patterns below err towards including a candidate.
 *
 * What it cannot see is a file written *indirectly*, by a script or tool the
 * command invokes (`python build.py`, `npm run build`, a formatter). Those
 * stay with git's shell-change detection (see git/gitStatus.ts), which needs
 * no snapshot because it asks git what moved.
 */

/** Commands whose arguments are files they write. */
const WRITING_COMMANDS = new Set(["tee", "cp", "mv", "touch", "rm", "sed", "perl", "truncate", "install", "dd"]);

/** Redirections that write their target. `<` and `<<<` are reads, so the
 *  heredoc/herestring a `cat > f <<'EOF'` also carries is not a candidate. */
const WRITE_REDIRECT = /^(?:[0-9]*|&)>>?\|?$/;

/** Never a real file to review: the shell's own sinks, and the kernel's. */
const NOT_A_FILE = /^\/(?:dev|proc|sys)\//;

/** A token we would have to run a shell to resolve. Expanding it ourselves
 *  would be guessing at a guess, so it is dropped. */
const UNRESOLVED = /[$`*?[\]{}]/;

/** The most candidates one command can contribute, so a pathological
 *  command line can't make the hook read the disk hundreds of times. */
const MAX_TARGETS = 64;

interface Token {
  text: string;
  /** An operator (`&&`, `|`, `>`, ...) rather than a word. */
  op: boolean;
}

/**
 * Drops every heredoc body, so the tokenizer never sees the note's own text
 * as shell syntax -- a body routinely holds quotes, `>` and `;`, and a
 * Markdown note is exactly the case this feature exists for. The `<<WORD`
 * token goes with it: a heredoc is stdin, never a write target.
 */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i += 1;
    const delimiters: Array<{ word: string; stripTabs: boolean }> = [];
    // Rewrites the line without its heredoc operators, collecting their
    // delimiters in the order the shell will look for them.
    // The replacer's parameters are annotated because String.replace types
    // its capture groups as `any`, which the review bot's no-unsafe-* rules
    // flag (see terminus-node-bridge's own hand-declared interfaces).
    const cleaned = line.replace(
      /<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][\w]*))/g,
      (_match: string, dash: string, single: string | undefined, double: string | undefined, bare: string | undefined) => {
        const word = single ?? double ?? bare;
        if (word) delimiters.push({ word, stripTabs: dash === "-" });
        return " ";
      }
    );
    kept.push(cleaned);
    for (const { word, stripTabs } of delimiters) {
      while (i < lines.length) {
        const body = lines[i] ?? "";
        i += 1;
        if ((stripTabs ? body.replace(/^\t+/, "") : body) === word) break;
      }
    }
  }
  return kept.join("\n");
}

/**
 * Splits into words and operators, honouring quoting the way the shell does
 * -- without it a path with a space ("Acme Notes") splits into two tokens
 * that resolve to nothing.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let has = false;
  const flush = (): void => {
    if (has) tokens.push({ text: current, op: false });
    current = "";
    has = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];

    if (c === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      has = true;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const body = end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      current += body;
      has = true;
      i = end === -1 ? command.length : end;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      flush();
      if (c === "\n") tokens.push({ text: "\n", op: true });
      continue;
    }
    // Operators. The redirect forms keep any fd prefix already collected in
    // `current` ("2>", "1>>"), since that prefix is part of the operator
    // rather than a word of its own.
    if (c === ">" || c === "<" || c === "|" || c === "&" || c === ";" || c === "(" || c === ")") {
      let op = c;
      const fd = /^[0-9]+$|^&$/.test(current) ? current : "";
      if (!fd) flush();
      else {
        current = "";
        has = false;
      }
      while (i + 1 < command.length && (command[i + 1] === c || (c !== ";" && (command[i + 1] === ">" || command[i + 1] === "|")))) {
        // `>>`, `&&`, `||`, `;;`, `>|`, `&>`, `&>>`
        if (op.length >= 3) break;
        op += command[i + 1];
        i += 1;
      }
      tokens.push({ text: fd + op, op: true });
      continue;
    }
    current += c;
    has = true;
  }
  flush();
  return tokens;
}

/** Already rooted: POSIX, or a Windows drive or UNC path. pathJoin is the
 *  only path primitive the Node bridge exposes, and it normalizes, so that
 *  plus this test covers what pathResolve would have done here. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Where a word points, as an absolute path, or null if it isn't a path we
 *  can resolve without running a shell. */
function resolveTarget(word: string, cwd: string, home: string | undefined): string | null {
  if (!word || word.startsWith("-") || UNRESOLVED.test(word)) return null;
  let path = word;
  if (path === "~" || path.startsWith("~/")) {
    if (!home) return null;
    path = path === "~" ? home : pathJoin(home, path.slice(2));
  }
  const absolute = ABSOLUTE.test(path) ? pathJoin(path) : pathJoin(cwd, path);
  if (NOT_A_FILE.test(absolute)) return null;
  return absolute;
}

/** Whether a `sed`/`perl` call edits in place, which is the only form of
 *  either that writes the file it is given rather than stdout. */
function editsInPlace(words: string[]): boolean {
  return words.some((w) => w === "-i" || /^-i[^-]*$/.test(w) || w === "--in-place" || /^--in-place=/.test(w));
}

export function parseShellWriteTargets(command: string, cwd: string, home?: string): string[] {
  const tokens = tokenize(stripHeredocs(command));
  const targets: string[] = [];
  const seen = new Set<string>();
  const add = (word: string, at: string): void => {
    const path = resolveTarget(word, at, home);
    if (!path || seen.has(path)) return;
    seen.add(path);
    targets.push(path);
  };

  // `cd "/some/vault/00_Inbox" && cat > "note.md" <<'EOF'` is the shape this
  // feature exists for, so the cwd a later segment writes into has to follow
  // the cd that preceded it rather than staying the session's.
  let at = cwd;
  let words: string[] = [];
  let pendingRedirect = false;

  const endSegment = (): void => {
    if (words.length === 0) return;
    // Leading VAR=value assignments aren't the command name.
    const start = words.findIndex((w) => !/^[A-Za-z_][\w]*=/.test(w));
    const argv = start === -1 ? [] : words.slice(start);
    const name = argv[0]?.split("/").pop() ?? "";

    if (name === "cd" && argv[1]) {
      const next = resolveTarget(argv[1], at, home);
      if (next) at = next;
    } else if (WRITING_COMMANDS.has(name)) {
      const args = argv.slice(1);
      // The empty argument BSD sed's `-i ''` needs is dropped here, so it
      // can't be mistaken for the positional script below.
      const files = args.filter((w) => w !== "" && !w.startsWith("-"));
      if (name === "sed" || name === "perl") {
        // Only in-place, and never the script itself (`sed -i 's/a/b/' f`)
        // -- unless -e/-f gave the script, in which case every positional
        // argument is a file.
        const scriptIsPositional = !args.some((w) => /^--(?:expression|file)\b/.test(w) || /^-[^-]*[ef]/.test(w));
        if (editsInPlace(args)) for (const f of scriptIsPositional ? files.slice(1) : files) add(f, at);
      } else if (name === "cp" || name === "mv" || name === "install") {
        // Only the destination is written; with several sources it's a
        // directory, whose contents we can't name without globbing.
        const destination = files.length === 2 ? files[1] : undefined;
        if (destination) add(destination, at);
      } else if (name === "dd") {
        for (const w of args) if (w.startsWith("of=")) add(w.slice(3), at);
      } else {
        // tee, touch, rm, truncate: every file argument.
        for (const f of files) add(f, at);
      }
    }
    words = [];
  };

  for (const token of tokens) {
    if (token.op) {
      if (WRITE_REDIRECT.test(token.text)) {
        pendingRedirect = true;
        continue;
      }
      // `<`, `<<<`, `|`, `&&`, `;`, newline, parens: none is a write.
      pendingRedirect = false;
      endSegment();
      continue;
    }
    if (pendingRedirect) {
      pendingRedirect = false;
      add(token.text, at);
      continue;
    }
    words.push(token.text);
  }
  endSegment();

  return targets.slice(0, MAX_TARGETS);
}
