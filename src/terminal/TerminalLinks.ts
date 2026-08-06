import { App, Notice, TFile } from "obsidian";
import { IBufferRange, IDisposable, ILink, Terminal } from "@xterm/xterm";
import { fileExistsSync, getEnvVar, pathJoin, pathRelative } from "terminus-node-bridge";
import { openWithSystemDefaultApp } from "../util/systemOpen";

export interface TerminalLinkContext {
  app: App;
  /** The shell's live cwd (CwdTracker), or null before the first OSC 7
   *  arrives -- relative paths fall back to the vault root in that case. */
  getCwd(): string | null;
  getVaultBasePath(): string;
}

/**
 * Extensions a bare word must end in before it's treated as a file path.
 * Without a whitelist, a "word.word" matcher linkifies ordinary prose
 * ("e.g.", "1.0.24", "www.google.com"), and a terminal full of false
 * underlines is worse than no linkification at all.
 */
const FILE_EXTENSIONS = [
  "md", "markdown", "txt", "canvas", "base", "pdf",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "json", "jsonc",
  "css", "scss", "sass", "less", "html", "htm", "xml", "svg",
  "py", "rb", "php", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cpp", "hpp", "cc", "cs",
  "sh", "bash", "zsh", "fish", "ps1",
  "yml", "yaml", "toml", "ini", "conf", "cfg", "env", "lock",
  "sql", "csv", "tsv", "log",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "mp3", "mp4", "mov", "wav", "m4a", "webm",
  "zip", "tar", "gz",
  "vue", "svelte", "astro",
];

/** No spaces: a path containing one is rare in terminal output, and
 *  allowing them makes the matcher swallow whole sentences. */
const PATH_SEGMENT = String.raw`[\w.@+\-]+`;

/** Trailing `:12` / `:12:34` is the near-universal "file:line[:col]" form
 *  compilers, linters and Claude itself print -- captured so a click can
 *  land on the right line rather than just the top of the file. */
const PATH_PATTERN = new RegExp(
  String.raw`(?:~\/|\.{1,2}\/|\/)?(?:${PATH_SEGMENT}\/)*${PATH_SEGMENT}\.(?:${FILE_EXTENSIONS.join("|")})(?::\d+){0,2}`,
  "g"
);

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'` ]+/gi;

/** Prose routinely ends a sentence right after a URL or path, and the
 *  terminating punctuation is virtually never part of the target. Closing
 *  brackets are only trimmed when unbalanced, so a genuine `foo(1).md`
 *  survives. */
function trimTrailingPunctuation(text: string): string {
  let result = text;
  for (;;) {
    const last = result.at(-1);
    if (!last) break;
    if (".,;:!?'\"".includes(last)) {
      result = result.slice(0, -1);
      continue;
    }
    const opener = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (opener) {
      const opens = result.split(opener).length - 1;
      const closes = result.split(last).length - 1;
      if (closes > opens) {
        result = result.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return result;
}

/** Guards against a pathological wrapped "line" (a minified blob, a base64
 *  payload) turning one hover into a multi-megabyte string scan. Claude's
 *  own wrapped output is a handful of rows. */
const MAX_WRAPPED_ROWS = 20;

interface LogicalLine {
  text: string;
  /** 0-based buffer row the joined text starts at. */
  startRow: number;
}

/**
 * xterm hands provideLinks a single buffer row, but a long path or URL is
 * routinely split across several rows by wrapping -- matching row-by-row
 * would find only the fragments. Walks back to the start of the wrapped
 * run and forward to its end, joining them into the logical line the user
 * actually sees.
 *
 * translateToString(false) deliberately keeps trailing whitespace: every
 * row except the last is exactly `cols` wide, which is what makes a string
 * offset convertible back into (x, y) buffer coordinates below.
 */
function readLogicalLine(term: Terminal, bufferLineNumber: number): LogicalLine | null {
  const buffer = term.buffer.active;
  const hovered = bufferLineNumber - 1;

  let startRow = hovered;
  while (startRow > 0 && hovered - startRow < MAX_WRAPPED_ROWS && buffer.getLine(startRow)?.isWrapped) {
    startRow--;
  }
  let endRow = hovered;
  while (
    endRow + 1 < buffer.length &&
    endRow - startRow < MAX_WRAPPED_ROWS &&
    buffer.getLine(endRow + 1)?.isWrapped
  ) {
    endRow++;
  }

  let text = "";
  for (let row = startRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) return null;
    text += line.translateToString(false);
  }
  return { text, startRow };
}

/** Inverse of the row-joining above: a string offset back into 1-based
 *  buffer coordinates. Assumes single-width cells -- a CJK or emoji glyph
 *  earlier on the line shifts the result, the same limitation xterm's own
 *  web-links addon carries. */
function toBufferRange(startRow: number, cols: number, index: number, length: number): IBufferRange {
  const endIndex = index + length - 1;
  return {
    start: { x: (index % cols) + 1, y: startRow + Math.floor(index / cols) + 1 },
    end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 },
  };
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

interface ParsedPath {
  path: string;
  /** 1-based, from a trailing ":42" -- undefined when none was present. */
  line?: number;
}

function parsePathTarget(raw: string): ParsedPath {
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(raw);
  if (!match?.[1]) return { path: raw };
  return { path: match[1], line: Number(match[2]) };
}

function resolveAbsolutePath(ctx: TerminalLinkContext, path: string): string {
  if (path.startsWith("~/")) {
    const home = getEnvVar("HOME") ?? getEnvVar("USERPROFILE");
    if (home) return pathJoin(home, path.slice(2));
  }
  if (isAbsolutePath(path)) return path;
  // A relative path in terminal output is relative to wherever the shell
  // currently is, not the vault -- which is exactly what CwdTracker knows.
  return pathJoin(ctx.getCwd() ?? ctx.getVaultBasePath(), path);
}

async function openPathTarget(ctx: TerminalLinkContext, raw: string): Promise<void> {
  const { path, line } = parsePathTarget(raw);
  const absolute = resolveAbsolutePath(ctx, path);
  const relative = pathRelative(ctx.getVaultBasePath(), absolute).replace(/\\/g, "/");

  if (!relative.startsWith("..")) {
    const file = ctx.app.vault.getAbstractFileByPath(relative);
    if (file instanceof TFile) {
      const leaf = ctx.app.workspace.getLeaf("tab");
      // Handed to openFile() as ephemeral state rather than applied
      // afterwards: the view finishes applying its own state, scroll
      // position included, after this promise settles, so a scroll issued
      // once it resolves gets overwritten and the file sits at the top.
      // The `:42` suffix is 1-based (compilers, linters and Claude all
      // count from one); eState.line is 0-based.
      await leaf.openFile(file, line === undefined ? undefined : { eState: { line: Math.max(0, line - 1) } });
      return;
    }
  }

  // Everything that lands here is a real file Obsidian simply can't show
  // as a note: a dot-file or anything under a dot-folder (the vault index
  // structurally excludes dot-prefixed paths, so getAbstractFileByPath
  // never returns one), a path outside the vault, or an extension no
  // editor view is registered for. Handing it to the OS is what a click on
  // a path in a terminal is asking for -- the alternative was a notice
  // explaining that nothing would happen.
  if (fileExistsSync(absolute)) {
    openWithSystemDefaultApp(absolute);
    return;
  }
  new Notice(`Terminus: couldn't find ${path}`);
}

function openUrlTarget(raw: string): void {
  const normalized = raw.startsWith("www.") ? `https://${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    new Notice(`Terminus: not a valid URL: ${raw}`);
    return;
  }
  // The matcher only ever produces http/https, but re-checking after
  // parsing keeps that guarantee local to the thing that acts on it.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  window.open(parsed.href, "_blank");
}

interface Candidate {
  index: number;
  text: string;
  open(): void;
}

function findCandidates(ctx: TerminalLinkContext, text: string): Candidate[] {
  const candidates: Candidate[] = [];
  const claimed: Array<[number, number]> = [];

  // URLs first, and paths skip anything overlapping one: the path matcher
  // would otherwise happily claim "example.com/notes/foo.md" out of the
  // middle of "https://example.com/notes/foo.md".
  URL_PATTERN.lastIndex = 0;
  for (let match = URL_PATTERN.exec(text); match; match = URL_PATTERN.exec(text)) {
    const matched = trimTrailingPunctuation(match[0]);
    if (!matched) continue;
    claimed.push([match.index, match.index + matched.length]);
    candidates.push({ index: match.index, text: matched, open: () => openUrlTarget(matched) });
  }

  PATH_PATTERN.lastIndex = 0;
  for (let match = PATH_PATTERN.exec(text); match; match = PATH_PATTERN.exec(text)) {
    const matched = trimTrailingPunctuation(match[0]);
    if (!matched) continue;
    const start = match.index;
    const end = start + matched.length;
    if (claimed.some(([from, to]) => start < to && end > from)) continue;
    // Only linkify a path that actually resolves. This is what keeps
    // fragments of hard-wrapped paths out: a TUI that wraps its own output
    // (Claude Code draws inside a bordered box and emits real newlines,
    // so there is no isWrapped flag to rejoin on) leaves the tail of a long
    // path sitting at the start of the next line, where it matches this
    // pattern perfectly well on its own -- ".../apps-terminus/memory/x.md"
    // offering "erminus/memory/x.md" as a link. No amount of pattern
    // tightening distinguishes that from a genuine relative path; asking
    // the filesystem does. It also disposes of the remaining prose false
    // positives for free.
    if (!fileExistsSync(resolveAbsolutePath(ctx, parsePathTarget(matched).path))) continue;
    candidates.push({ index: start, text: matched, open: () => void openPathTarget(ctx, matched) });
  }

  return candidates;
}

/**
 * A small tooltip anchored inside the terminal, matching what VS Code shows
 * on a terminal link. It's what makes the modifier requirement
 * discoverable -- without it, an underlined path that ignores a plain click
 * reads as broken.
 *
 * The "xterm-hover" class is load-bearing, not decoration: xterm checks for
 * it in Linkifier's mousemove handler and stops treating the pointer as
 * having left the link, so the tooltip doesn't flicker itself out of
 * existence when the mouse crosses onto it.
 */
class LinkTooltip {
  private el: HTMLElement | null = null;

  constructor(private readonly term: Terminal) {}

  show(event: MouseEvent, label: string): void {
    const parent = this.term.element;
    if (!parent) return;
    this.hide();
    const el = parent.createDiv({ cls: "xterm-hover terminus-link-hover", text: label });
    const bounds = parent.getBoundingClientRect();
    el.setCssProps({
      "--terminus-link-hover-left": `${event.clientX - bounds.left}px`,
      "--terminus-link-hover-top": `${event.clientY - bounds.top}px`,
    });
    this.el = el;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}

const MODIFIER_LABEL = navigator.userAgent.includes("Mac") ? "Cmd" : "Ctrl";

/**
 * Makes file paths and URLs in terminal output clickable.
 *
 * Activation deliberately requires Cmd/Ctrl rather than a plain click, the
 * same as VS Code's terminal (xterm's own default is a plain click). A
 * terminal is a surface people click constantly just to focus it or move
 * the cursor, and Claude's output is dense with paths -- on a plain click
 * every one of those becomes an accidental tab.
 */
export function registerTerminalLinks(term: Terminal, ctx: TerminalLinkContext): IDisposable {
  const tooltip = new LinkTooltip(term);

  const provider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const logical = readLogicalLine(term, bufferLineNumber);
      if (!logical) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      for (const candidate of findCandidates(ctx, logical.text)) {
        const range = toBufferRange(logical.startRow, term.cols, candidate.index, candidate.text.length);
        // provideLinks is called per row, but the joined logical line spans
        // several -- drop matches that don't touch the row actually asked
        // about, or every row of a wrapped run reports the same link.
        if (bufferLineNumber < range.start.y || bufferLineNumber > range.end.y) continue;
        links.push({
          range,
          text: candidate.text,
          activate(event) {
            // Plain clicks fall through to xterm's normal focus/selection
            // handling, which is what makes the terminal still feel like a
            // terminal.
            if (!event.metaKey && !event.ctrlKey) return;
            tooltip.hide();
            candidate.open();
          },
          hover(event) {
            tooltip.show(event, `${MODIFIER_LABEL} + click to open`);
          },
          leave() {
            tooltip.hide();
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });

  return {
    dispose() {
      tooltip.hide();
      provider.dispose();
    },
  };
}
