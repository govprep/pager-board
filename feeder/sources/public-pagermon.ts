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
  // Unreachable from the feeder box directly, not unwanted. Cloudflare 403s
  // that IP on every path and every transport — with a browser User-Agent as
  // much as without — and nothing on our side fixes it. It connects fine from a
  // residential connection, which is why it only showed up once deployed.
  //
  // Retested 2026-09-06: still 403 (cf-ray a369b6a98f505081-SYD). The body is
  // the WAF block page ("Sorry, you have been blocked … forcequit.xyz"), not
  // Bot Fight Mode's challenge, so it's a firewall rule on the zone naming the
  // apex domain. Only the host's operator can lift it — worth asking, with the
  // IP and that Ray ID, since it's the one fix that needs nothing running.
  //
  // Until then it goes out through a residential connection instead: set
  // FEEDER_PROXY_FORCEQUIT to a SOCKS5 proxy on one (see withProxy below and
  // the README) and this entry switches itself on. Verify the route first —
  //   curl -o /dev/null -w '%{http_code}\n' --socks5-hostname 127.0.0.1:1080 \
  //     'https://pager.forcequit.xyz/socket.io/?EIO=3&transport=polling'
  // needs to be 200 where the same call without --socks5-hostname is 403.
  {
    label: "forcequit",
    baseUrl: "https://pager.forcequit.xyz",
    disabled:
      "Cloudflare 403s this host's IP — set FEEDER_PROXY_FORCEQUIT to a SOCKS5 proxy on an unblocked connection",
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
  // additions are now what the follow-up alert is built on: a device alerted to a
  // new incident auto-follows it, and the appliances that arrive afterwards buzz
  // it. The duty-officer and ops pages that make this feed distinctive are the
  // one thing held back — they're paged to nearly everything, so an addition
  // naming only them is dropped (lib/units.ts). Slack posts them all as replies
  // in the job's existing thread regardless.
  //
  // Its thin addresses are safe here only because poster.ts refuses an upsert
  // that would cost a stored row its coordinates or its LGA. Without that guard
  // this instance would have overwritten 168 good rows in the same sample.
  //
  // Its FRNSW pages come laid out with dashes rather than keys —
  // "FRINC: MEDICAL ACCESS EMERGENCY – 234 – INC: 156043" — which the parser
  // now reads as layout C, keyed on the turnout exactly as the canonical form
  // is. Station numbers resolve through the same index, so 234 shows as
  // "234 BOWRAL" and a device subscribed to 234 matches it.
  { label: "pager-feed", baseUrl: "https://pager-feed.net" },
];

/**
 * Apply `FEEDER_PROXY_<LABEL>` to an instance, if it's set.
 *
 * The label is upper-cased with anything a shell won't accept in a variable
 * name folded to `_`, so pager-feed reads FEEDER_PROXY_PAGER_FEED. Any instance
 * can be routed this way; only forcequit needs it today.
 *
 * Supplying a route also clears `disabled`, which is the point rather than a
 * side effect: `disabled` means "we can't reach this host", and a proxy is us
 * reaching it. It would be the wrong lever for an instance switched off because
 * we distrust its data — that judgement belongs to `rawOnly` and `barFromBoard`,
 * which this doesn't touch.
 *
 * Read here, at call time, rather than where the table is declared: index.ts
 * loads .env.local in its module body, and ES imports are evaluated before that
 * runs, so a module-scope process.env read would always come up empty.
 */
export function withProxy(inst: LiveInstance): LiveInstance {
  const key = `FEEDER_PROXY_${inst.label.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const proxy = process.env[key]?.trim();
  if (!proxy) return inst;
  return { ...inst, proxy, disabled: undefined };
}

/** Subscribe to every public instance. Each reconnects independently. */
export function pollPublicPagerMons(post: PostFn): void {
  for (const inst of PUBLIC_INSTANCES) void pollPagerMonLive(post, withProxy(inst));
}
