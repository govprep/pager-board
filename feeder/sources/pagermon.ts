import type { PostFn, PagerLine } from "../poster";
import { passesBoardFilter } from "../../lib/filter";

interface PagerMonMessage {
  id: number;
  message: string;
  source?: string;
  timestamp?: number;
  address?: string;          // capcode
  alias?: string | null;     // brigade/station name for that capcode
  agency?: string | null;
  ignore?: number | null;
}

// Everything PagerMon reports is recorded in the raw feed; the board filter runs
// in poster.ts. The one thing we still honour here is PagerMon's own `ignore`
// flag — that's the operator having explicitly muted a capcode, so it's barred
// from the board (but still shown raw).
//
// Returns [] for a message with no text — the API is external, and the board
// filter that used to absorb that case no longer runs here.
function toLines(m: PagerMonMessage): PagerLine[] {
  const raw = typeof m.message === "string" ? m.message.trim() : "";
  if (!raw) return [];
  return [{
    raw,
    receivedAt: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : undefined,
    boardEligible: !m.ignore,
    // PagerMon's address/agency/alias are rfspager's Capcode/Agency/Brigade
    // under different names — e.g. "0125111" / "FRNSW" / "251 Cardiff".
    capcode: m.address ?? null,
    agency: m.agency ?? null,
    origin: m.alias ?? null,
  }];
}

interface PagerMonResponse {
  messages?: PagerMonMessage[];
}

let sessionCookie = "";

async function login(base: string, user: string, pass: string): Promise<boolean> {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
    redirect: "manual",
  });
  // PagerMon sets connect.sid via Set-Cookie on the login response.
  const cookie = res.headers.get("set-cookie");
  if (!cookie) return false;
  // Extract just the name=value part (strip flags like Path, HttpOnly, etc).
  sessionCookie = cookie.split(";")[0].trim();
  return !!sessionCookie;
}

async function getMessages(
  base: string,
  lastId: number,
): Promise<PagerMonMessage[]> {
  const params = new URLSearchParams({ limit: "100" });
  if (lastId) params.set("since", String(lastId));
  const res = await fetch(`${base}/api/messages?${params}`, {
    headers: { Accept: "application/json", Cookie: sessionCookie },
  });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: PagerMonResponse | PagerMonMessage[] = await res.json();
  return Array.isArray(data) ? data : (data.messages ?? []);
}

export async function pollPagerMon(post: PostFn): Promise<void> {
  const base = process.env.PAGERMON_URL?.replace(/\/$/, "");
  const user = process.env.PAGERMON_USER ?? "";
  const pass = process.env.PAGERMON_PASS ?? "";

  if (!base || !user || !pass) {
    console.warn("[pagermon] PAGERMON_URL, PAGERMON_USER, PAGERMON_PASS required — skipping");
    return;
  }

  const ok = await login(base, user, pass);
  if (!ok) {
    console.error("[pagermon] login failed");
    return;
  }
  console.log("[pagermon] logged in");

  // Seed the cursor and post the 30 most recent valid messages to populate the board.
  let lastId = 0;
  try {
    const seed = await getMessages(base, 0);
    if (seed.length) lastId = Math.max(...seed.map((m) => m.id ?? 0));

    // Everything is recorded raw; only the 30 most recent board-worthy lines are
    // allowed onto the board, so a first-ever run doesn't fire a Slack post and
    // a phone push for the whole backlog.
    let budget = 30;
    const toPost: PagerLine[] = seed.flatMap(toLines).map((line) => {
      if (!line.boardEligible || !passesBoardFilter(line.raw)) return line;
      if (budget > 0) {
        budget--;
        return line;
      }
      return { ...line, boardEligible: false };
    });
    if (toPost.length) await post(toPost, "pagermon");

    console.log(`[pagermon] cursor seeded at id ${lastId}, posted ${toPost.length} recent message(s)`);
  } catch (err) {
    console.error("[pagermon] failed to seed cursor:", err instanceof Error ? err.message : err);
  }

  async function tick() {
    try {
      let messages = await getMessages(base!, lastId);

      // Session expired — re-login once and retry.
      if (!messages.length && lastId === 0) {
        // first fetch with no results might just be empty
      } else if (!messages.length) {
        await login(base!, user, pass);
        messages = await getMessages(base!, lastId);
      }

      if (!messages.length) return;

      const maxId = Math.max(...messages.map((m) => m.id ?? 0));
      if (maxId >= lastId) lastId = maxId + 1;

      await post(messages.flatMap(toLines), "pagermon");
    } catch (err) {
      console.error("[pagermon]", err instanceof Error ? err.message : err);
    }
  }

  tick();
  setInterval(tick, pollMs());
}

// This is *your own* PagerMon, so the poll costs nobody else anything — the
// interval is set by how stale a page may be, not by politeness. At 30s it
// added a mean 15s to every page only it carried; 15s halves that.
//
// It rarely wins the race outright (it was first for about 10% of jobs in a
// week's sample, and dropping it entirely delayed the rest by a median of 0s),
// so this is worth little on its own — it matters for the jobs no live socket
// hears at all. Override with PAGERMON_POLL_MS if the box minds.
const DEFAULT_POLL_MS = 15_000;

function pollMs(): number {
  const raw = Number(process.env.PAGERMON_POLL_MS);
  return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_POLL_MS;
}
