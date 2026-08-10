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
  // Three things still bar a line from the *board*: the instance being raw-only,
  // PagerMon's own `ignore` flag (an operator having muted that capcode), and the
  // project-wide rule that SES traffic never reaches the board (the agency field
  // catches SES pages whose text alone wouldn't give them away).
  const boardEligible =
    !inst.rawOnly && !msg.ignore && !/^SES$/i.test(agency ?? "");

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

/** Subscribe to one PagerMon instance's live broadcast. Reconnects on its own. */
export async function pollPagerMonLive(
  post: PostFn,
  inst: LiveInstance,
): Promise<void> {
  const tag = `[${inst.label}]`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let io: any;
  try {
    io = (await import("socket.io-client")).default ?? (await import("socket.io-client"));
  } catch {
    console.error(`${tag} socket.io-client not installed — run: npm install socket.io-client@2`);
    return;
  }

  // Open on HTTP long-polling and let Socket.IO upgrade to a WebSocket once
  // it's connected — the library's own default, and the order matters.
  //
  // Pinning this to ["websocket"] (as the original pocsag-only version did)
  // means a blocked upgrade has nothing to fall back to: every host in front of
  // these instances is Cloudflare, and a network that won't pass a WSS upgrade
  // gets `connect error: websocket error` forever instead of a working polling
  // connection. Long-polling is a little chattier and no less live.
  const socket = io(inst.baseUrl, {
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 30_000,
  });

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

  socket.on("messagePost", (msg: PagerMonLiveMessage) => {
    const line = toLine(msg, inst);
    if (!line) return;
    post([line], inst.label).catch((err) =>
      console.error(tag, err instanceof Error ? err.message : err),
    );
  });
}
