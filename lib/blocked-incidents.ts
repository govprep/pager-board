// Decoder-corrupted incidents that must never be shown as live board cards.
const BLOCKED_INCIDENTS = new Set(["26-131793"]);

export function isBlockedIncident(incidentNo: string | null | undefined): boolean {
  return BLOCKED_INCIDENTS.has(incidentNo?.trim() ?? "");
}
