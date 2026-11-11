import { Notice } from "obsidian";
import type TerminusPlugin from "../main";
import type { AgentSession } from "../state/AgentSessionStore";
import { TerminalView } from "../views/TerminalView";
import { attentionTransition, previewText, stillCurrent, type NotifyKind, type StatusSnapshot } from "./notifyRules";

/** Herdr's default: long enough that a prompt answered at once, or a turn
 *  that is looked at as it ends, never pops anything. */
const DELAY_MS = 1000;
/** Program-requested notifications (OSC 9/777, the agent API) per terminal. */
const MESSAGE_MIN_INTERVAL_MS = 3000;
const IN_APP_DURATION_MS = 8000;

export interface NotifyRequest {
  kind: NotifyKind;
  title: string;
  body: string | null;
  /** The terminal it's about: clicking opens it, and it's suppressed while
   *  that terminal is in front. */
  token?: string;
}

/**
 * Tells the user when a session needs them or finishes while they're
 * looking elsewhere, as an Obsidian notice or a system notification, with
 * an optional tone. Driven by AgentSessionStore's status changes (the
 * hooks), plus messages programs and agents ask for themselves.
 */
export class Notifier {
  private last = new Map<string, StatusSnapshot>();
  private timers = new Map<string, number>();
  private lastMessageAt = new Map<string, number>();
  private audio: AudioContext | null = null;

  constructor(private plugin: TerminusPlugin) {}

  /** Every AgentSessionStore change. */
  onSessionChange(session: AgentSession): void {
    const next: StatusSnapshot = { status: session.status, needs: session.needs };
    const prev = this.last.get(session.token);
    this.last.set(session.token, next);
    if (!session.running) {
      this.cancel(session.token);
      this.last.delete(session.token);
      return;
    }
    const kind = attentionTransition(prev, next);
    if (!kind || !this.wants(kind)) return;
    this.cancel(session.token);
    const timer = window.setTimeout(() => {
      this.timers.delete(session.token);
      const now = this.plugin.agentSessionStore.get(session.token);
      if (!now?.running || !stillCurrent(kind, { status: now.status, needs: now.needs })) return;
      this.deliver(this.describe(kind, now));
    }, DELAY_MS);
    this.timers.set(session.token, timer);
  }

  /** A program in a terminal asked for one (OSC 9/777). A terminal with a
   *  Claude session is left to the hooks, which already notify for it and
   *  know more; Claude Code may send its own OSC 9 on top. */
  fromTerminal(token: string, title: string | null, body: string): void {
    if (this.plugin.agentSessionStore.get(token)?.running) return;
    this.message(token, title, body);
  }

  /** An agent asked for one through the agent API. False when it was
   *  dropped: notifications off, or too soon after the last. */
  message(token: string, title: string | null, body: string | null): boolean {
    if (this.plugin.settings.notifications.delivery === "off") return false;
    const now = Date.now();
    if (now - (this.lastMessageAt.get(token) ?? 0) < MESSAGE_MIN_INTERVAL_MS) return false;
    this.lastMessageAt.set(token, now);
    const name = this.plugin.findTerminalView(token)?.getDisplayText() ?? "Terminus";
    this.deliver({ kind: "message", title: title ? `${name}: ${title}` : name, body, token });
    return true;
  }

  /** The settings tab's test button: always shown, whatever is in front. */
  test(): void {
    if (this.plugin.settings.notifications.delivery === "off") {
      new Notice("Terminus: notifications are off");
      return;
    }
    this.deliver({ kind: "needs-input", title: "Terminus", body: "Notifications are working." }, true);
  }

  dispose(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    void this.audio?.close();
    this.audio = null;
  }

  private wants(kind: NotifyKind): boolean {
    const settings = this.plugin.settings.notifications;
    if (settings.delivery === "off") return false;
    if (kind === "needs-input") return settings.needsInput;
    if (kind === "finished") return settings.finished;
    return true;
  }

  private cancel(token: string): void {
    const timer = this.timers.get(token);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.timers.delete(token);
  }

  private describe(kind: NotifyKind, session: AgentSession): NotifyRequest {
    const name = this.plugin.findTerminalView(session.token)?.getDisplayText() ?? "Claude";
    if (kind === "needs-input") {
      const body = session.needsMessage ?? (session.needs === "permission" ? "Claude needs your permission" : "Claude is waiting for your input");
      return { kind, title: `${name} needs you`, body, token: session.token };
    }
    const title = session.lastTurnFailed ? `${name}: the turn failed` : `${name} finished`;
    return { kind, title, body: previewText(session.lastMessage), token: session.token };
  }

  /** The user is already looking at this terminal: its own window has
   *  focus and it's the active view. */
  private isInFront(token: string): boolean {
    const view = this.plugin.findTerminalView(token);
    if (!view) return false;
    const doc = view.containerEl.ownerDocument;
    return doc.hasFocus() && this.plugin.app.workspace.getActiveViewOfType(TerminalView) === view;
  }

  private deliver(request: NotifyRequest, force = false): void {
    if (!force && request.token && this.isInFront(request.token)) return;
    const settings = this.plugin.settings.notifications;
    const open = (): void => {
      window.focus();
      if (request.token) void this.plugin.focusTerminal(request.token);
    };
    if (settings.delivery === "system" && typeof Notification !== "undefined") {
      // Silent: the tone below is ours, and the system's would double it.
      const notification = new Notification(request.title, { body: request.body ?? "", silent: true });
      notification.onclick = open;
    } else {
      const fragment = createFragment((f) => {
        const el = f.createDiv({ cls: "terminus-notice" });
        el.createDiv({ cls: "terminus-notice-title", text: request.title });
        if (request.body) el.createDiv({ cls: "terminus-notice-body", text: request.body });
        if (request.token) el.addEventListener("click", open);
      });
      new Notice(fragment, IN_APP_DURATION_MS);
    }
    if (settings.sound) this.playTone(request.kind);
  }

  /** A bell-like ding from WebAudio: two quick ones when Claude needs the
   *  user, one lower and softer when it's done. Generated rather than a
   *  sound file, which an Obsidian release can't ship. */
  private playTone(kind: NotifyKind): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      const start = ctx.currentTime + 0.01;
      if (kind === "finished") {
        this.ding(ctx, start, 880, 0.16);
      } else {
        this.ding(ctx, start, 1175, 0.18);
        this.ding(ctx, start + 0.16, 1175, 0.14);
      }
    } catch {
      // No audio device, or WebAudio unavailable: the notification itself
      // has already been shown.
    }
  }

  /**
   * One struck-bell note: an instant attack, then each partial dying away
   * on its own, the higher ones faster, which is what makes a ding rather
   * than a beep. The partials are a small bell's slightly inharmonic
   * overtones, quiet beside the fundamental.
   */
  private ding(ctx: AudioContext, at: number, frequency: number, volume: number): void {
    const partials = [
      { ratio: 1, gain: 1, decay: 1.4 },
      { ratio: 2.76, gain: 0.32, decay: 0.55 },
      { ratio: 5.4, gain: 0.12, decay: 0.25 },
    ];
    for (const partial of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency * partial.ratio;
      const peak = volume * partial.gain;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + partial.decay);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + partial.decay + 0.05);
    }
  }
}
