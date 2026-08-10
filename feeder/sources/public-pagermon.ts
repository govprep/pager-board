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

  // Raw feed only — deliberately, and not a config we expect to relax.
  //
  // pager-feed.net publishes a *cleaned-up* rendering of the traffic rather than
  // the decode: it drops the call class, rewrites the job type to title case,
  // truncates the address at the suburb (so no LGA and no postcode), drops the
  // coordinates entirely, and re-lays FRNSW pages out as
  // "FRINC: TREE DOWN – 083 – INC: 155945" instead of the "TURNOUT:"/"INC:"
  // key-value form the parser reads.
  //
  // That matters because the board upserts on `{incidentNo}-{unit}`, which this
  // feed reproduces exactly — so a page already on the board from pocsag or
  // rfspager would be overwritten by a copy with no coordinates and no LGA,
  // quietly breaking the map link and dropping the incident out of every
  // area-narrowed device's alerts. Measured against the live board, 168 of the
  // 425 incidents in a two-day sample would have been overwritten this way.
  //
  // It also adds almost nothing: 1% of the incident numbers it carried in that
  // window were ones no other source had. So we record it — it still corroborates
  // and it costs nothing to keep watching — and never parse it.
  { label: "pager-feed", baseUrl: "https://pager-feed.net", rawOnly: true },
];

/** Subscribe to every public instance. Each reconnects independently. */
export function pollPublicPagerMons(post: PostFn): void {
  for (const inst of PUBLIC_INSTANCES) void pollPagerMonLive(post, inst);
}
