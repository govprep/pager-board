import type { PostFn, PagerLine } from "../poster";

// ---------------------------------------------------------------------------
// PagerMon's live Socket.IO broadcast, shared by every public instance we watch.
//
// pocsag.net, pager-feed.net and pager.forcequit.xyz all run PagerMon, so they
// all push each decode as a "messagePost" event carrying one message object —
// same event name, same field names, no auth. The only thing that differs
// between them is the host, the label we record, and (see `rawOnly`) how much
// we trust what comes out.
//
// The authenticated REST poller for a *private* PagerMon lives separately in
// sources/pagermon.ts; that one needs a login and a cursor, this one doesn't.
// ---------------------------------------------------------------------------

/** Shape of a PagerMon "messagePost" payload — only the fields we use. */
export interface PagerMonLiveMessage {
  message?: string;
  timestamp?: number; // Unix seconds
  agency?: string | null;
  address?: string | number | null; // capcode
  alias?: string | null; // brigade/station name for that capcode
  ignore?: number | null;
}

export interface LiveInstance {
  /** Recorded as the source on every row — becomes a badge on /raw. */
  label: string;
  /** Origin, no trailing slash, e.g. "https://pocsag.net". */
  baseUrl: string;
  /**
   * Record every line in the raw feed but never let one onto the board.
   *
   * For instances that re-publish a *reformatted* copy of the traffic rather
   * than the decode itself. Their text no longer carries what the board needs
   * (see pager-feed.net in sources/public-pagermon.ts), and because the board
   * upserts on `{incidentNo}-{unit}` a degraded copy would overwrite a good row
   * from another source. Raw-only keeps the corroboration without the damage.
   */
  rawOnly?: boolean;
  /**
   * Bar just *some* of this instance's lines from the board, by their text.
   * Recorded on /raw either way, exactly like `rawOnly` — this is the same
   * judgement applied at line granularity, for an instance that is trustworthy
   * on one kind of page and not another.
   */
  barFromBoard?: (raw: string) => boolean;
  /**
   * Why this instance is switched off. Truthy = don't connect at all, just say
   * so once at startup. For a host that can't be reached rather than one we've
   * chosen to distrust — an unreachable source otherwise retries every 30s
   * forever and buries the log.
   */
  disabled?: string;
  /**
   * Dial this instance — and only this instance — through a SOCKS5 proxy, e.g.
   * "socks5://127.0.0.1:1080". Set per instance from the environment; see
   * `withProxy` in sources/public-pagermon.ts.
   *
   * For a host that refuses this machine's IP rather than the request itself:
   * pager.forcequit.xyz is 403'd by a Cloudflare WAF rule on the zone, which no
   * amount of header tuning gets past, while the identical request from a
   * residential connection is waved through. A proxy parked on such a
   * connection is the difference, so it's scoped to the one instance that needs
   * it — every other source keeps its direct path.
   */
  proxy?: string;
}

// Instances disagree on how to spell an agency: pocsag.net says "FRNSW" and
// "SES", pager-feed.net says "Fire Rescue NSW" and "State Emergency Service".
// Fold the long forms onto the short ones the rest of the pipeline already uses,
// so /raw's Agency column stays filterable and — the part that matters — the SES
// board rule below still recognises SES traffic whichever instance reported it.
//
// RFS *district* names ("Central Coast", "Lower Hunter") are deliberately left
// alone: lib/origin.ts already puts districts in this slot for RFS pages.
const AGENCY_ALIASES: Record<string, string> = {
  "fire rescue nsw": "FRNSW",
  "fire & rescue nsw": "FRNSW",
  "fire and rescue nsw": "FRNSW",
  "state emergency service": "SES",
  "nsw ses": "SES",
  "nsw state emergency service": "SES",
  "rural fire service": "RFS",
  "nsw rfs": "RFS",
  "nsw rural fire service": "RFS",
};

export function normaliseAgency(agency: string | null | undefined): string | null {
  const a = (agency ?? "").trim();
  if (!a) return null;
  return AGENCY_ALIASES[a.toLowerCase()] ?? a;
}

/** One live message → the line we record, or null if there's no text in it. */
export function toLine(
  msg: PagerMonLiveMessage,
  inst: LiveInstance,
): PagerLine | null {
  if (!msg || typeof msg.message !== "string") return null;
  const raw = msg.message.trim();
  if (!raw) return null;

  const agency = normaliseAgency(msg.agency);

  // Everything is recorded in the raw feed — the board filter runs in poster.ts.
  // Four things still bar a line from the *board*: the instance being raw-only,
  // its own per-line bar, PagerMon's `ignore` flag (an operator having muted
  // that capcode), and the project-wide rule that SES traffic never reaches the
  // board (the agency field catches SES pages whose text alone wouldn't give
  // them away).
  const boardEligible =
    !inst.rawOnly &&
    !inst.barFromBoard?.(raw) &&
    !msg.ignore &&
    !/^SES$/i.test(agency ?? "");

  return {
    raw,
    receivedAt: msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined,
    boardEligible,
    capcode: msg.address != null ? String(msg.address) : null,
    agency,
    origin: msg.alias ?? null,
  };
}

// Mirrors feeder/sources/rfspager.ts — see the note on the connection below.
// Origin/Referer are per-instance: a browser on the site would send that site's
// own origin, and a mismatched one is worse than none.
function browserHeaders(baseUrl: string): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept-Language": "en-AU,en;q=0.9",
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
  };
}

/**
 * Build the agent that routes one instance's traffic through `proxy`.
 *
 * SOCKS only, and loudly so. The tunnel this exists for is OpenSSH's reverse
 * dynamic forward (`ssh -N -R 1080`), which speaks SOCKS5 — and handing
 * socks-proxy-agent an http:// URL doesn't fail, it just quietly connects
 * direct, which for a host that blocks this IP means 403ing forever while the
 * log claims a proxy is in use. Better to refuse the URL by name.
 *
 * Imported lazily so the four instances that don't use a proxy never load it.
 */
export async function proxyAgentFor(proxy: string): Promise<unknown> {
  if (!/^socks(4a?|5h?)?:\/\//i.test(proxy)) {
    throw new Error(
      `proxy must be a socks:// URL — got "${proxy}". ` +
        `An http:// proxy would be ignored rather than honoured.`,
    );
  }
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  return new SocksProxyAgent(proxy);
}

/**
 * The options one instance's Socket.IO connection is opened with.
 *
 * Split out from the call below so the proxy wiring is testable without a
 * network: an `agent` given here reaches both transports, because engine.io
 * builds each one with `agent: options.agent || this.agent`
 * (engine.io-client/lib/socket.js:178) — the XHR handshake at
 * transports/polling-xhr.js:78 and the ws upgrade at
 * transports/websocket.js:99. It has to arrive as the same object, not a copy.
 *
 * With no agent the key is absent entirely rather than set to undefined, so an
 * unproxied instance is opened with exactly what it was before this existed.
 */
export function liveSocketOptions(
  inst: LiveInstance,
  agent?: unknown,
): Record<string, unknown> {
  // Open on HTTP long-polling and let Socket.IO upgrade to a WebSocket once
  // it's connected — the library's own default, and the order matters.
  //
  // Pinning this to ["websocket"] (as the original pocsag-only version did)
  // means a blocked upgrade has nothing to fall back to: every host in front of
  // these instances is Cloudflare, and a network that won't pass a WSS upgrade
  // gets `connect error: websocket error` forever instead of a working polling
  // connection. Long-polling is a little chattier and no less live.
  const headers = browserHeaders(inst.baseUrl);

  return {
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 30_000,
    // Socket.IO sends no User-Agent of its own, and every one of these hosts is
    // behind Cloudflare, which will refuse a UA-less request from a datacenter
    // IP while waving the same request through from a residential one — so this
    // fails only once deployed. rfspager.ts carries the same headers for the
    // same reason. Applied to both transports: the handshake is XHR, the
    // upgrade is a WS request, and Cloudflare inspects each.
    extraHeaders: headers,
    transportOptions: {
      polling: { extraHeaders: headers },
      websocket: { extraHeaders: headers },
    },
    ...(agent ? { agent } : {}),
  };
}

// ---------------------------------------------------------------------------
// Silence watchdog.
//
// A socket that stops delivering looks exactly like a quiet night from the
// inside: the connection stays open, ping/pong keeps passing, and no
// `disconnect` ever fires — so `reconnection: true` above never has anything to
// react to. Over a three-day sample pocsag.net was silent for 84% of the window
// with individual gaps of six hours, while pager-feed.net on this same code was
// quiet only 26% of the time; pocsag reached us for just 15% of the jobs the
// board saw, against pager-feed's 73%. It wasn't that pocsag had stopped
// broadcasting — our end had stopped listening and had no way to tell.
//
// So liveness is judged on messages arriving rather than on the socket's
// opinion of itself, and a feed that has said nothing for SILENCE_MS is torn
// down and redialled.
//
// The threshold is set by how long we're willing to be blind, not by how quiet
// a feed may legitimately go. Bouncing a healthy-but-idle socket costs one
// handshake and loses nothing; missing a dead one cost six hours. 20 minutes is
// therefore deliberately shorter than the 83-minute lull pager-feed showed on a
// quiet night — those nights just redial a few times, which is the cheap half
// of the trade.
export const SILENCE_MS = 20 * 60_000;

export interface SilenceWatchdog {
  /** Mark the feed alive — called on connect and on every message. */
  alive: (now: number) => void;
  /** True when the feed has been silent long enough to be worth redialling. */
  check: (now: number) => boolean;
}

/**
 * Track when a feed last said anything, and answer whether it has gone quiet
 * for longer than `silenceMs`.
 *
 * Firing re-arms the window, so a reconnect that fixes nothing is caught again
 * a full silence later rather than on the next tick — otherwise a genuinely
 * dead host would be redialled in a tight loop.
 */
export function makeSilenceWatchdog(silenceMs: number, now: number): SilenceWatchdog {
  let lastHeard = now;
  return {
    alive(at: number) {
      lastHeard = at;
    },
    check(at: number) {
      if (at - lastHeard < silenceMs) return false;
      lastHeard = at;
      return true;
    },
  };
}

/** Subscribe to one PagerMon instance's live broadcast. Reconnects on its own. */
export async function pollPagerMonLive(
  post: PostFn,
  inst: LiveInstance,
): Promise<void> {
  const tag = `[${inst.label}]`;

  if (inst.disabled) {
    console.warn(`${tag} disabled — ${inst.disabled}`);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let io: any;
  try {
    io = (await import("socket.io-client")).default ?? (await import("socket.io-client"));
  } catch {
    console.error(`${tag} socket.io-client not installed — run: npm install socket.io-client@2`);
    return;
  }

  // A proxied instance is one that can't be reached directly at all, so a proxy
  // we can't build is a reason not to connect rather than something to shrug
  // off: dialling direct would just 403 on a five-second loop, which is the
  // exact noise `disabled` exists to prevent.
  let agent: unknown;
  if (inst.proxy) {
    try {
      agent = await proxyAgentFor(inst.proxy);
    } catch (err) {
      console.error(
        `${tag} not connecting — unusable proxy:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    console.log(`${tag} routing via ${inst.proxy}`);
  }

  const socket = io(inst.baseUrl, liveSocketOptions(inst, agent));

  socket.on("connect", () =>
    console.log(
      `${tag} connected via Socket.IO (${socket.io?.engine?.transport?.name ?? "?"})` +
        (inst.rawOnly ? " — raw feed only" : ""),
    ),
  );
  // Which transport won is the first thing you want to know when one host
  // connects and another doesn't, so log the upgrade too.
  socket.on("connect", () => {
    socket.io?.engine?.once?.("upgrade", () =>
      console.log(`${tag} upgraded to ${socket.io?.engine?.transport?.name}`),
    );
  });
  socket.on("disconnect", (reason: string) => console.warn(`${tag} disconnected:`, reason));
  socket.on("connect_error", (err: Error) => console.warn(`${tag} connect error:`, err.message));

  const watchdog = makeSilenceWatchdog(SILENCE_MS, Date.now());
  socket.on("connect", () => watchdog.alive(Date.now()));

  socket.on("messagePost", (msg: PagerMonLiveMessage) => {
    watchdog.alive(Date.now());
    const line = toLine(msg, inst);
    if (!line) return;
    post([line], inst.label).catch((err) =>
      console.error(tag, err instanceof Error ? err.message : err),
    );
  });

  // Checked on a timer rather than driven by the socket, precisely because the
  // socket is the thing that has stopped telling us anything. See SILENCE_MS.
  setInterval(() => {
    if (!watchdog.check(Date.now())) return;
    console.warn(
      `${tag} nothing heard for ${Math.round(SILENCE_MS / 60_000)} min — redialling`,
    );
    try {
      socket.disconnect();
      socket.connect();
    } catch (err) {
      console.error(`${tag} redial failed:`, err instanceof Error ? err.message : err);
    }
  }, 60_000);
}
