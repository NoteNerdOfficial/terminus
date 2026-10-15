import { pathBasename, pathDirname, pathJoin, readTextFileIfExists } from "terminus-node-bridge";

/**
 * Token, context and estimated-cost totals read from Claude Code's session
 * transcripts (JSONL), for the Agent inbox. Read only when a hook says
 * something happened (see TerminalView); nothing here polls or watches.
 *
 * Each assistant message records its `usage` and `model`. A streamed message
 * can be written as several lines sharing one message id, so the last line
 * per id counts. Subagents write their own transcript files, every line
 * marked as a sidechain, so a lead transcript's sidechain lines (older
 * Claude Code versions kept subagents inline) are skipped to avoid counting
 * a subagent twice.
 *
 * Checked against Claude Code 2.1.296: for a session with two subagents,
 * input and cache tokens summed this way match its own `cost-state` record
 * exactly, and the cost comes within its internal helper calls, which no
 * transcript records. Claude Code writes that record only when a session
 * exits, so it can't serve a live inbox.
 */

/** USD per million tokens. */
interface ModelPrice {
  input: number;
  /** Writes to the 5-minute prompt cache. */
  cacheWrite5m: number;
  /** Writes to the 1-hour prompt cache. */
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

interface ModelInfo {
  /** Matched against the start of the model id; the longest match wins. */
  prefix: string;
  price: ModelPrice;
  /** Haiku 5.5 charges more for prompts over 100,000 tokens. */
  longPromptPrice?: ModelPrice;
  contextWindow: number;
}

const MILLION = 1_000_000;
const LONG_PROMPT_TOKENS = 100_000;
/** US-only inference (`inference_geo`) costs 1.1x on Claude 4.6 and later. */
const US_ONLY_MULTIPLIER = 1.1;

const price = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): ModelPrice => ({
  input,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
  output,
});

/**
 * From Anthropic's pricing and context-window pages, checked 2026-10-12.
 * Updated with releases; a model missing here shows tokens but no cost.
 * Claude 4.6 and later have a 1M-token window at standard pricing (Haiku
 * 5.5's long-prompt rate aside); older models have 200k.
 */
const MODELS: ModelInfo[] = [
  { prefix: "claude-fable-5-1", price: price(10, 12.5, 20, 0.25, 50), contextWindow: MILLION },
  { prefix: "claude-mythos-5-1", price: price(10, 12.5, 20, 0.25, 50), contextWindow: MILLION },
  { prefix: "claude-fable-5", price: price(10, 12.5, 20, 1, 50), contextWindow: MILLION },
  { prefix: "claude-mythos-5", price: price(10, 12.5, 20, 1, 50), contextWindow: MILLION },
  { prefix: "claude-opus-5-5", price: price(4, 5, 8, 0.2, 20), contextWindow: MILLION },
  { prefix: "claude-opus-5", price: price(5, 6.25, 10, 0.5, 25), contextWindow: MILLION },
  { prefix: "claude-opus-4-8", price: price(5, 6.25, 10, 0.5, 25), contextWindow: MILLION },
  { prefix: "claude-opus-4-7", price: price(5, 6.25, 10, 0.5, 25), contextWindow: MILLION },
  { prefix: "claude-opus-4-6", price: price(5, 6.25, 10, 0.5, 25), contextWindow: MILLION },
  { prefix: "claude-opus-4-5", price: price(5, 6.25, 10, 0.5, 25), contextWindow: 200_000 },
  { prefix: "claude-opus-4-1", price: price(15, 18.75, 30, 1.5, 75), contextWindow: 200_000 },
  { prefix: "claude-opus-4", price: price(15, 18.75, 30, 1.5, 75), contextWindow: 200_000 },
  { prefix: "claude-sonnet-5-5", price: price(2, 2.5, 4, 0.1, 10), contextWindow: MILLION },
  { prefix: "claude-sonnet-5", price: price(2, 2.5, 4, 0.2, 10), contextWindow: MILLION },
  { prefix: "claude-sonnet-4-6", price: price(3, 3.75, 6, 0.3, 15), contextWindow: MILLION },
  { prefix: "claude-sonnet-4-5", price: price(3, 3.75, 6, 0.3, 15), contextWindow: 200_000 },
  { prefix: "claude-sonnet-4", price: price(3, 3.75, 6, 0.3, 15), contextWindow: 200_000 },
  {
    prefix: "claude-haiku-5-5",
    price: price(0.1, 0.125, 0.2, 0.01, 0.5),
    longPromptPrice: price(0.5, 0.625, 1, 0.05, 2.5),
    contextWindow: MILLION,
  },
  { prefix: "claude-haiku-4-5", price: price(1, 1.25, 2, 0.1, 5), contextWindow: 200_000 },
  { prefix: "claude-3-5-haiku", price: price(0.8, 1, 1.6, 0.08, 4), contextWindow: 200_000 },
];

function modelInfo(model: string): ModelInfo | null {
  let best: ModelInfo | null = null;
  for (const info of MODELS) {
    if (model.startsWith(info.prefix) && (!best || info.prefix.length > best.prefix.length)) best = info;
  }
  return best;
}

/** A model id as a short name: `claude-sonnet-5-5` → "Sonnet 5.5",
 *  `claude-3-5-haiku-20241022` → "Haiku 3.5". An id with no family name in
 *  it is returned as is. */
export function formatModelName(model: string): string {
  const parts = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .split("-");
  const family = parts.find((part) => /^[a-z]+$/.test(part));
  if (!family) return model;
  const version = parts.filter((part) => /^\d+$/.test(part)).join(".");
  return `${family.charAt(0).toUpperCase()}${family.slice(1)}${version ? ` ${version}` : ""}`;
}

/** One assistant message's `usage`, as the transcript records it. */
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  inference_geo?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when any message's model isn't in the price table: no guessing. */
  costUsd: number | null;
  /** The latest message's prompt size (input + cache), i.e. how full the
   *  context is; null before the first message. */
  contextTokens: number | null;
  /** The latest message's model's window; null for an unknown model. */
  contextWindow: number | null;
  model: string | null;
}

export function totalTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Adds two totals, e.g. a lead and its subagents. Context stays the
 *  first's: it describes one conversation, not a sum. */
export function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    ...a,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}

interface MessageUsage {
  model: string;
  usage: RawUsage;
}

export type TranscriptKind = "lead" | "subagent";

interface FileState {
  /** Characters of the file already parsed, up to the last full line. */
  parsed: number;
  /** Message id → its latest usage, in first-seen order. */
  messages: Map<string, MessageUsage>;
  /** The latest counted message, for context size. */
  latest: MessageUsage | null;
}

/**
 * Remembers how far each transcript has been parsed, so each read parses
 * only what was appended since. (The whole file is still read from disk:
 * the Node bridge has no ranged read, and reads happen only at turn
 * boundaries.)
 */
export class TranscriptUsageReader {
  private files = new Map<string, FileState>();
  /** One read per file at a time, so two hooks landing together can't
   *  parse the same appended lines twice. */
  private pending = new Map<string, Promise<UsageTotals | null>>();

  /** Null when the transcript doesn't exist (Claude Code may not be saving
   *  transcripts) or has no assistant messages yet. */
  read(path: string, kind: TranscriptKind): Promise<UsageTotals | null> {
    const previous = this.pending.get(path) ?? Promise.resolve(null);
    const next = previous.then(
      () => this.readNow(path, kind),
      () => this.readNow(path, kind)
    );
    this.pending.set(path, next);
    return next;
  }

  forget(path: string): void {
    this.files.delete(path);
    this.pending.delete(path);
  }

  private async readNow(path: string, kind: TranscriptKind): Promise<UsageTotals | null> {
    const text = await readTextFileIfExists(path);
    if (text === null) {
      this.files.delete(path);
      return null;
    }
    let state = this.files.get(path);
    // A file shorter than what was parsed has been replaced: start over.
    if (!state || text.length < state.parsed) {
      state = { parsed: 0, messages: new Map(), latest: null };
      this.files.set(path, state);
    }
    const end = text.lastIndexOf("\n") + 1;
    if (end > state.parsed) {
      for (const line of text.slice(state.parsed, end).split("\n")) parseLine(line, state, kind);
      state.parsed = end;
    }
    return state.messages.size === 0 ? null : summarize(state);
  }
}

function parseLine(line: string, state: FileState, kind: TranscriptKind): void {
  if (!line.includes('"assistant"')) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof entry !== "object" || entry === null) return;
  const e = entry as { type?: unknown; isSidechain?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } };
  if (e.type !== "assistant" || (kind === "lead" && e.isSidechain === true)) return;
  const message = e.message;
  if (!message || typeof message.id !== "string" || typeof message.model !== "string") return;
  if (typeof message.usage !== "object" || message.usage === null) return;
  // Claude Code's own placeholder for an API error: no tokens were used.
  if (message.model === "<synthetic>") return;
  const usage: MessageUsage = { model: message.model, usage: message.usage };
  state.messages.set(message.id, usage);
  state.latest = usage;
}

function summarize(state: FileState): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd: number | null = 0;
  for (const { model, usage } of state.messages.values()) {
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;

    const info = modelInfo(model);
    if (!info || costUsd === null) {
      costUsd = null;
      continue;
    }
    const prompt = input + cacheRead + cacheWrite;
    const p = info.longPromptPrice && prompt > LONG_PROMPT_TOKENS ? info.longPromptPrice : info.price;
    // The split by cache lifetime, when recorded; otherwise all 5-minute.
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : cacheWrite;
    let cost = input * p.input + output * p.output + cacheRead * p.cacheRead + write5m * p.cacheWrite5m + write1h * p.cacheWrite1h;
    if (usage.inference_geo === "us") cost *= US_ONLY_MULTIPLIER;
    costUsd += cost / MILLION;
  }

  const latest = state.latest;
  const latestInfo = latest ? modelInfo(latest.model) : null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    contextTokens: latest
      ? (latest.usage.input_tokens ?? 0) + (latest.usage.cache_read_input_tokens ?? 0) + (latest.usage.cache_creation_input_tokens ?? 0)
      : null,
    contextWindow: latestInfo?.contextWindow ?? null,
    model: latest?.model ?? null,
  };
}

/** Where Claude Code keeps a subagent's transcript, next to the lead's:
 *  `<dir>/<session>.jsonl` → `<dir>/<session>/subagents/agent-<id>.jsonl`. */
export function subagentTranscriptPath(leadTranscriptPath: string, agentId: string): string | null {
  if (!leadTranscriptPath.endsWith(".jsonl")) return null;
  const session = pathBasename(leadTranscriptPath, ".jsonl");
  return pathJoin(pathDirname(leadTranscriptPath), session, "subagents", `agent-${agentId}.jsonl`);
}
