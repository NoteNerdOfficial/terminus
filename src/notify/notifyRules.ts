import type { AgentStatus, NeedsKind } from "../state/AgentSessionStore";

/** What a notification is about. `message` is one a program or an agent
 *  asked for itself (OSC 9/777, or the agent API's notify). */
export type NotifyKind = "needs-input" | "finished" | "message";

export interface StatusSnapshot {
  status: AgentStatus;
  needs: NeedsKind | null;
}

/** A session that wants the user: a permission prompt or a question. An
 *  unread finished turn re-flagged by idle_prompt doesn't count; it was
 *  already announced as finished. */
function wantsInput(s: StatusSnapshot): boolean {
  return s.status === "needs-attention" && s.needs !== "unread-turn";
}

/**
 * The notification a session's status change calls for, if any. Only the
 * edge into a state is announced, never a state that merely persists, so
 * the many `change` events a working session emits (each edit, each usage
 * read) stay silent.
 */
export function attentionTransition(prev: StatusSnapshot | undefined, next: StatusSnapshot): NotifyKind | null {
  if (wantsInput(next) && !(prev && wantsInput(prev))) return "needs-input";
  if (next.status === "finished-unread" && prev?.status !== "finished-unread") return "finished";
  return null;
}

/** Whether a pending notification still describes the session when its
 *  delay is up: the prompt was answered, or the turn was looked at, in the
 *  meantime and there's nothing left to say. */
export function stillCurrent(kind: NotifyKind, now: StatusSnapshot): boolean {
  if (kind === "needs-input") return wantsInput(now);
  if (kind === "finished") return now.status === "finished-unread";
  return true;
}

export interface OscNotification {
  title: string | null;
  body: string;
}

const MAX_OSC_TEXT = 300;

/**
 * A desktop notification a program asked for with an escape sequence:
 * OSC 9 (iTerm2's form: the whole payload is the message) or OSC 777
 * (`notify;title;body`, the rxvt/Ghostty form). OSC 9 is shared with
 * ConEmu's numbered subcommands -- `9;4;1;50` is a progress report, not a
 * message -- so a payload that starts with a number and a semicolon is
 * not one.
 */
export function parseOscNotification(ident: number, data: string): OscNotification | null {
  if (ident === 9) {
    if (/^\d+(;|$)/.test(data)) return null;
    const body = clean(data);
    return body ? { title: null, body } : null;
  }
  if (ident === 777) {
    const parts = data.split(";");
    if (parts[0] !== "notify") return null;
    const title = clean(parts[1] ?? "");
    const body = clean(parts.slice(2).join(";"));
    if (!title && !body) return null;
    return { title: title || null, body };
  }
  return null;
}

function clean(text: string): string {
  // Character by character rather than a control-character regex, which
  // lint rules reject.
  const printable = Array.from(text, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, MAX_OSC_TEXT);
}

/** One line of a message for a notification's body. */
export function previewText(text: string | null, max = 160): string | null {
  if (!text) return null;
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
