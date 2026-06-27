// Routes an incident to a Slack channel by matching its free-text location.
//
// Matching is a simple ordered substring scan against the UPPERCASED location:
// the first entry whose pattern appears wins. Order matters — put specific
// suburbs/towns above the broader LGA fallbacks so a precise match takes
// precedence over the catch-all region.
//
// Channels can be names ("#queanbeyan") or Slack channel IDs ("C0123ABC").
// Fill these in to match your workspace. Unmatched locations fall back to
// SLACK_DEFAULT_CHANNEL (env), or are skipped if that's unset.

interface AreaRule {
  /** Substring to look for in the uppercased location. */
  pattern: string;
  /** Slack channel name (with #) or channel ID to post into. */
  channel: string;
}

// Most specific first. LGAs (broad) live at the bottom as fallbacks.
const AREA_RULES: AreaRule[] = [
  // ── Specific towns / suburbs ──────────────────────────────────────────────
  { pattern: "WAMBOIN", channel: "#area-wamboin" },
  { pattern: "SUTTON", channel: "#area-sutton" },
  { pattern: "LAKE GEORGE", channel: "#area-lake-george" },
  { pattern: "BUNGENDORE", channel: "#area-bungendore" },

  // ── LGA fallbacks (broad) ─────────────────────────────────────────────────
  { pattern: "QUEANBEYAN-PALERANG", channel: "#area-qprc" },
  { pattern: "QUEANBEYAN PALERANG", channel: "#area-qprc" },
  { pattern: "YASS VALLEY", channel: "#area-yass" },
  { pattern: "GOULBURN", channel: "#area-goulburn" },
];

/**
 * Pick the Slack channel for an incident location. Returns null when nothing
 * matches and no default is configured — the caller decides whether to skip.
 */
export function channelForLocation(location: string): string | null {
  const hay = (location ?? "").toUpperCase();
  for (const rule of AREA_RULES) {
    if (hay.includes(rule.pattern)) return rule.channel;
  }
  return process.env.SLACK_DEFAULT_CHANNEL || null;
}
