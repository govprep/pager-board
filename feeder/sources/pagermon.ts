import type { PostFn } from "../poster";
import { isValidPagerLine } from "../filter";

interface PagerMonMessage {
  id: number;
  message: string;
  source?: string;
  timestamp?: number;
  alias?: string;
  agency?: string;
  ignore?: number | null;
}

function isUsable(m: PagerMonMessage): boolean {
  if (m.ignore) return false;
  return isValidPagerLine(m.message);
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

  // Seed the cursor to the latest message so a fresh start (or restart after
  // a board clear) doesn't re-flood the board with old messages.
  let lastId = 0;
  try {
    const seed = await getMessages(base, 0);
    if (seed.length) lastId = Math.max(...seed.map((m) => m.id ?? 0));
    console.log(`[pagermon] cursor seeded at id ${lastId}`);
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
      if (maxId > 0) lastId = maxId;

      const lines = messages
        .filter(isUsable)
        .map((m) => m.message.trim());

      await post(lines, "pagermon");
    } catch (err) {
      console.error("[pagermon]", err instanceof Error ? err.message : err);
    }
  }

  tick();
  setInterval(tick, 30_000);
}
