// Clock formatting shared by the board, the raw feed and the topbar clock.
// 24-hour, zero-padded, en-AU — a control-room read, not a locale-flavoured one.

export function fmtTime(iso: string, secs = false): string {
  return new Date(iso).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    ...(secs ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

/** "2m", "4h", "6d" — compact relative age, e.g. for a live-traffic gutter or
 *  "how stale is this reading" note. `now` defaults to render time; pass an
 *  explicit (ticking) value for a display that must keep counting up. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "2026-08-11" — the local-day bucket a row is grouped under. */
export function dateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
