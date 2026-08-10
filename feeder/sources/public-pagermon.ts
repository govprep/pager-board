import type { PostFn } from "../poster";
import { pollPagerMonLive, type LiveInstance } from "./pagermon-live";

// ---------------------------------------------------------------------------
// The public PagerMon instances we listen to. Each is a separate receiver
// network watching the same NSW paging system, so they overlap heavily — that's
// the point. A page one instance misses (or decodes badly) usually arrives
// intact from another, and the raw feed collapses the copies into one row
// listing every source that saw it.
//
// Adding an instance is a line in this table. Removing one is deleting it.
// ---------------------------------------------------------------------------

export const PUBLIC_INSTANCES: LiveInstance[] = [
  // The original. RFS + FRNSW, full-fidelity decodes, capcode/agency/alias on
  // every message.
  { label: "pocsag", baseUrl: "https://pocsag.net" },

  // NSW PSN feed hosted by Forcequit. Same PagerMon build, same message shape,
  // and its lines are byte-identical to pocsag's on the pages both see — it just
  // covers different receivers, so it fills in the Illawarra/Shoalhaven traffic
  // our other sources are thin on. Worth having: 33 of the 57 incident numbers
  // it carried in a two-day sample were ones no other source had.
  //
  // Off because the feeder box can't reach it, not because we don't want it.
  // Cloudflare 403s that IP on every path and every transport — with a browser
  // User-Agent as much as without, the body naming "bot" — so this is the zone
  // blocking a datacenter IP, most likely Bot Fight Mode, and nothing on our
  // side fixes it. It connects fine from a residential connection, which is why
  // it only showed up once deployed.
  //
  // To turn back on: get the server's IP allowlisted by whoever runs the host,
  // then delete the `disabled` line. Verify with
  //   curl -o /dev/null -w '%{http_code}\n' \
  //     'https://pager.forcequit.xyz/socket.io/?EIO=3&transport=polling'
  // which needs to be 200 from the box, not 403.
  {
    label: "forcequit",
    baseUrl: "https://pager.forcequit.xyz",
    disabled: "Cloudflare 403s the feeder's IP — needs allowlisting by the host",
  },

  // pager-feed.net publishes a *cleaned-up* rendering rather than the decode:
  // no call class, job type re-cased, address truncated at the suburb (so no
  // LGA and no postcode), and no coordinates at all.
  //
  // It's here for depth rather than breadth. Its receiver hears capcodes the
  // others don't — duty officers and ops especially (LHDO, CCDO, LHOPS18) — and
  // because a board row is keyed on {incidentNo}-{unit}, each of those is a row
  // no other source produces. In a two-day sample it added 80 unit pages to jobs
  // already on the board, against only 3 incident numbers nobody else had. Those
  // additions cost nothing in noise: push skips unit-additions to an incident
  // that has already alerted, and Slack posts them as replies in the job's
  // existing thread.
  //
  // Its thin addresses are safe here only because poster.ts refuses an upsert
  // that would cost a stored row its coordinates or its LGA. Without that guard
  // this instance would have overwritten 168 good rows in the same sample.
  //
  // FRNSW stays barred. Those pages arrive as
  // "FRINC: TREE DOWN – 083 – INC: 155945" rather than the TURNOUT:/INC: form
  // the parser reads, so they'd land with no type and no unit — and with no
  // turnout, no device that picked FRNSW stations would match them. pocsag and
  // pagermon already carry FRNSW properly, so there's nothing to recover.
  {
    label: "pager-feed",
    baseUrl: "https://pager-feed.net",
    barFromBoard: (raw) => /\bFRINC\b/i.test(raw),
  },
];

/** Subscribe to every public instance. Each reconnects independently. */
export function pollPublicPagerMons(post: PostFn): void {
  for (const inst of PUBLIC_INSTANCES) void pollPagerMonLive(post, inst);
}
