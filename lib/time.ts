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

/** "2026-08-11" — the local-day bucket a row is grouped under. */
export function dateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
