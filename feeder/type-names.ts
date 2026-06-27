// Turns terse pager incident types into human-friendly names for Slack.
//
// Strategy (cheapest first):
//   1. Known abbreviation? → use the static dictionary.
//   2. Already readable (has a space or lowercase)? → just title-case it.
//   3. Short all-caps code we don't know? → ask Claude Haiku once, then cache.
//
// AI is strictly decoration: any failure (no key, network, bad response) falls
// back to a title-cased version of the raw type, so a page is never blocked.

const MODEL = "claude-haiku-4-5-20251001";

// Well-known fire-service abbreviations. Keys are uppercased, no punctuation.
const DICTIONARY: Record<string, string> = {
  AFA: "Automatic fire alarm",
  ALARM: "Fire alarm",
  RCR: "Rescue / road crash",
  MVA: "Motor vehicle accident",
  MVC: "Motor vehicle collision",
  FIRECALL: "Fire call",
  HAZMAT: "Hazardous materials",
  ACR: "Aircraft incident",
  BUSHFIRE: "Bushfire",
  GRASS: "Grass fire",
  STRUCT: "Structure fire",
  AGENCY: "Assist other agency",
};

// Resolved names, keyed by uppercased raw type. Seeded from the dictionary and
// grown by AI lookups so each unknown code costs at most one model call per run.
const cache = new Map<string, string>();

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Looks like an opaque code rather than a phrase: short, single token, all caps.
function looksLikeCode(type: string): boolean {
  return /^[A-Z0-9]{2,6}$/.test(type) && !/\s/.test(type);
}

async function askHaiku(type: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 24,
        system:
          "You expand terse Australian fire/rescue pager incident codes into a " +
          "short human-readable name (2-4 words, sentence case). Reply with ONLY " +
          "the name, no punctuation or explanation. If unsure, echo the code.",
        messages: [{ role: "user", content: `Code: ${type}` }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((b) => b.type === "text")?.text?.trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a friendly incident-type name. Never throws — worst case it returns a
 * title-cased version of the input.
 */
export async function friendlyType(rawType: string): Promise<string> {
  const type = (rawType ?? "").trim();
  if (!type) return "";

  const upper = type.toUpperCase();
  if (cache.has(upper)) return cache.get(upper)!;
  if (DICTIONARY[upper]) {
    cache.set(upper, DICTIONARY[upper]);
    return DICTIONARY[upper];
  }

  // Multi-word or mixed-case types are already readable — don't spend a call.
  if (!looksLikeCode(type)) {
    const nice = titleCase(type);
    cache.set(upper, nice);
    return nice;
  }

  const ai = await askHaiku(type);
  const resolved = ai && ai.toUpperCase() !== upper ? titleCase(ai) : titleCase(type);
  cache.set(upper, resolved);
  return resolved;
}
