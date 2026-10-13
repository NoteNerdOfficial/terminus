/** When a snoozed group comes back. Presets follow t3code's: an hour,
 *  three hours, this evening (only while it's meaningfully before
 *  evening), tomorrow morning and next week. Calendar presets use local
 *  calendar days rather than fixed 24-hour offsets, which land on the
 *  wrong day across a daylight-saving change, and presets that land on
 *  the same moment collapse (on a Sunday "Tomorrow" and "Next week" are
 *  both Monday morning, so only "Tomorrow" is offered). */
export interface SnoozePreset {
  id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";
  label: string;
  /** Epoch ms. */
  until: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MORNING_HOUR = 9;
const EVENING_HOUR = 18;

function atHour(base: Date, daysAhead: number, hour: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + daysAhead);
  next.setHours(hour, 0, 0, 0);
  return next;
}

export function resolveSnoozePresets(now: Date): SnoozePreset[] {
  const presets: SnoozePreset[] = [
    { id: "hour", label: "In an hour", until: now.getTime() + HOUR_MS },
    { id: "three-hours", label: "In three hours", until: now.getTime() + 3 * HOUR_MS },
  ];
  // "This evening" only while it's at least three hours off.
  const evening = atHour(now, 0, EVENING_HOUR);
  if (evening.getTime() - now.getTime() >= 3 * HOUR_MS) presets.push({ id: "evening", label: "This evening", until: evening.getTime() });
  const tomorrow = atHour(now, 1, MORNING_HOUR);
  presets.push({ id: "tomorrow", label: "Tomorrow morning", until: tomorrow.getTime() });
  // Next Monday morning; on a Sunday that is tomorrow, so it's dropped.
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  const monday = atHour(now, daysToMonday, MORNING_HOUR);
  if (monday.getTime() !== tomorrow.getTime()) presets.push({ id: "next-week", label: "Next week", until: monday.getTime() });
  return presets;
}

/** "3:05 PM", or "Wed 9:00 AM" when it isn't today. */
export function wakeLabel(until: number, now = Date.now()): string {
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
