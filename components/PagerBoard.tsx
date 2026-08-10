"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Incident, PagerMessage, RawStatus } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";
import { hasIncidentNumber } from "@/lib/parser";
import { dedupeMessages } from "@/lib/incident-messages";
import { fullerOf, isLaterType } from "@/lib/incident-merge";
import { lgaFromLocation, lgaKey } from "@/lib/lga";
import EnableAlerts from "@/components/EnableAlerts";
import IncidentMap from "@/components/IncidentMap";
import { pushSupported, isFollowing, followIncident, unfollowIncident } from "@/lib/push-client";

function fmt(iso: string, secs = false) {
  return new Date(iso).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    ...(secs ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

function dateKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "09/08 14:32:07" — a job's pages can straddle midnight, so the per-incident
// message log carries the date as well as the clock time.
function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${fmt(iso, true)}`;
}

function typeClass(type: string): string {
  const t = type.toLowerCase();
  if (/fire|chimney|grass|bush|structure|blaze/.test(t)) return "fire";
  if (/mva|accident|rescue|collision|rcr/.test(t)) return "rescue";
  if (/hazmat|chemical|spill|gas/.test(t)) return "hazmat";
  if (/medical|patient|cardiac/.test(t)) return "medical";
  if (/storm|flood|tree|wire/.test(t)) return "storm";
  if (/afa|alarm|auto/.test(t)) return "afa";
  return "default";
}

// True on Apple platforms (iPhone/iPad/iPod, plus macOS — modern iPadOS reports
// as "Macintosh"). Guarded for SSR where navigator is undefined.
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
}

// Universal Google Maps link — works everywhere and is the safe SSR / right-click
// default. Apple users get routed to Apple Maps at click time (see openInMaps).
function googleMapsHref(coords: { lat: number; lng: number }): string {
  return `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
}

// Open the incident in the platform's preferred maps app. Apple platforms open
// Apple Maps; everyone else falls through to the anchor's Google Maps href.
function openInMaps(
  e: React.MouseEvent<HTMLAnchorElement>,
  coords: { lat: number; lng: number },
) {
  if (!isApplePlatform()) return; // let the default Google Maps href handle it
  e.preventDefault();
  window.open(
    `https://maps.apple.com/?q=${coords.lat},${coords.lng}`,
    "_blank",
    "noopener,noreferrer",
  );
}


// Split a unit string into the badges to display. FRNSW labels are
// "<number> STATION NAME" (e.g. "428 QUEANBEYAN") and must stay as a single
// badge — even when several are packed in one string after a merge
// ("357 LAMBTON 454 TARRO" -> two badges). Everything else is split into
// individual station codes (all-uppercase alphanumeric, 2+ chars).
function unitTokens(unit: string): string[] {
  const u = unit.trim();
  if (!u) return [];
  if (/^\d+\s+[A-Z]/.test(u)) {
    const groups = u.match(/\d+\s+[A-Z][A-Z. ]*?(?=\s+\d|\s*$)/g);
    if (groups) return groups.map(g => g.trim());
    return [u];
  }
  const codes = u.split(/[\s,/]+/).filter(t => /^[A-Z0-9]{2,}$/.test(t));
  return codes.length > 0 ? codes : [u.split(/\s+/)[0]];
}

function UnitBadges({ unit }: { unit: string }) {
  if (!unit) return <span className="dim">—</span>;
  const tokens = unitTokens(unit);
  return <>{tokens.map(u => <span key={u} className="badge">{u}</span>)}</>;
}

function splitAddress(loc: string): { street: string; locality: string } {
  if (!loc) return { street: "", locality: "" };
  const parts = loc.split(",");
  return {
    street: parts[0]?.trim() ?? "",
    locality: parts.slice(1).join(", ").trim(),
  };
}

// How long a row stays marked as having just gained a resource: two 2s pulses.
// Kept in step with the `unit-added-pulse` animation in globals.css — the class
// is dropped on a timer rather than on animationend so it still clears for
// someone whose reduced-motion setting has turned the animation down.
const FLASH_MS = 4000;

// How many rows to pull per request. The board loads the newest page first,
// then fetches older pages on scroll (see the IntersectionObserver below).
const PAGE_SIZE = 200;

// Combine two row lists, keyed by id (unique per incident+unit), newest first.
// Later lists win on conflict, so a refresh's fresh rows replace stale copies.
function mergeById(...lists: Incident[][]): Incident[] {
  const byId = new Map<string, Incident>();
  for (const list of lists) for (const i of list) byId.set(i.id, i);
  return [...byId.values()].sort((a, b) =>
    a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0,
  );
}

// One resource paged to a job. `stopped` marks the ones a stand-down has since
// cancelled — control routinely stands some brigades down while the rest keep
// working, so this is per-resource rather than per-incident.
type Unit = { name: string; stopped: boolean };

type Entry = { inc: Incident; units: Unit[] };

function UnitBadge({ unit }: { unit: Unit }) {
  return (
    <span
      className={`badge${unit.stopped ? " stopped" : ""}`}
      title={unit.stopped ? "Stood down — stand-down received for this resource" : undefined}
    >
      {unit.name}
    </span>
  );
}

// Per-incident "Follow updates" toggle. Subscribing enables device push (if it
// isn't already) and registers this device to be notified when a unit is added
// to this incident. Hidden entirely when push isn't available.
type FollowState = "loading" | "off" | "on" | "busy" | "unsupported";

function FollowButton({ incidentNo }: { incidentNo: string }) {
  const [state, setState] = useState<FollowState>("loading");

  useEffect(() => {
    let active = true;
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    isFollowing(incidentNo).then((f) => {
      if (active) setState(f ? "on" : "off");
    });
    return () => { active = false; };
  }, [incidentNo]);

  if (state === "unsupported") return null;

  async function toggle() {
    if (state === "on") {
      setState("busy");
      const ok = await unfollowIncident(incidentNo);
      setState(ok ? "off" : "on");
    } else if (state === "off") {
      setState("busy");
      const ok = await followIncident(incidentNo);
      setState(ok ? "on" : "off");
    }
  }

  const busy = state === "busy" || state === "loading";
  const label =
    state === "on" ? "🔔 Following" :
    busy ? "…" :
    "🔔 Follow updates";

  return (
    <button
      className={`follow-btn${state === "on" ? " on" : ""}`}
      onClick={toggle}
      disabled={busy}
      title="Get a phone alert when a new unit is added to this incident"
    >
      {label}
    </button>
  );
}

// ── per-incident message log ───────────────────────────────────────────────
// Every pager line the pipeline tied to this incident number: the first page,
// each re-page to another brigade, and the stand-down.

// Only the exceptions are labelled — "on board" is the expected outcome, so
// tagging every line with it would bury the ones worth noticing.
const MSG_STATUS_TAG: Partial<Record<RawStatus, string>> = {
  standdown: "STAND DOWN",
  dropped: "DROPPED",
};

type MessagesState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; rows: PagerMessage[] };

function IncidentMessages({ state }: { state: MessagesState }) {
  if (state.phase === "loading") {
    return <div className="msg-note">Loading messages…</div>;
  }
  if (state.phase === "error") {
    return <div className="msg-note">Couldn&apos;t load the messages for this incident.</div>;
  }
  if (state.rows.length === 0) {
    return (
      <div className="msg-note">
        No pager messages recorded for this incident.
      </div>
    );
  }

  return (
    <ol className="msg-list">
      {state.rows.map((m) => (
        <li key={m.hash} className={`msg ${m.status}`}>
          <div className="msg-meta">
            <span className="msg-time">{fmtStamp(m.receivedAt)}</span>
            {MSG_STATUS_TAG[m.status] && (
              <span className={`raw-status ${m.status}`}>{MSG_STATUS_TAG[m.status]}</span>
            )}
            {m.origin && <span className="msg-origin">{m.origin}</span>}
            {m.agency && <span className="agency-tag">{m.agency}</span>}
            <span className="msg-spacer" />
            {m.sources.map((s) => <span key={s} className="badge">{s}</span>)}
            {m.seenCount > 1 && (
              <span
                className="seen-count"
                title={`Reported ${m.seenCount} times — last at ${fmt(m.lastSeenAt, true)}`}
              >
                ×{m.seenCount}
              </span>
            )}
          </div>
          <div className="raw-line">{m.raw}</div>
        </li>
      ))}
    </ol>
  );
}

type ModalTab = "details" | "messages";

function IncidentModal({
  entry,
  getToken,
  onClose,
}: {
  entry: Entry;
  getToken: () => string | null;
  onClose: () => void;
}) {
  const { inc, units } = entry;
  const [tab, setTab] = useState<ModalTab>("details");
  const [messages, setMessages] = useState<MessagesState>({ phase: "loading" });

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pulled as soon as the card opens rather than when the tab is picked, so the
  // tab can show how many pages this job has before you go looking.
  useEffect(() => {
    if (!inc.incidentNo) {
      setMessages({ phase: "ready", rows: [] });
      return;
    }
    let active = true;
    setMessages({ phase: "loading" });
    (async () => {
      try {
        const token = getToken();
        const params = new URLSearchParams({ incidentNo: inc.incidentNo, limit: "200" });
        const res = await fetch(`/api/raw?${params}`, {
          cache: "no-store",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!active) return;
        setMessages({
          phase: "ready",
          rows: dedupeMessages(Array.isArray(data.messages) ? data.messages : []),
        });
      } catch {
        if (active) setMessages({ phase: "error" });
      }
    })();
    return () => { active = false; };
  // getToken is a fresh closure on every parent render; re-running on it would
  // refetch for nothing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inc.incidentNo]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* The fixed height applies only on the message log — see globals.css. */}
      <div
        className={`modal incident-modal${tab === "messages" ? " on-messages" : ""}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-top">
          <div className="modal-head">
            <div className="modal-inc-group">
              <span className="modal-inc">{inc.incidentNo || "Incident"}</span>
            </div>
            <div className="modal-head-actions">
              {inc.incidentNo && <FollowButton incidentNo={inc.incidentNo} />}
              <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
            </div>
          </div>

          <div className="modal-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "details"}
              className={`modal-tab${tab === "details" ? " on" : ""}`}
              onClick={() => setTab("details")}
            >
              Details
            </button>
            <button
              role="tab"
              aria-selected={tab === "messages"}
              className={`modal-tab${tab === "messages" ? " on" : ""}`}
              onClick={() => setTab("messages")}
            >
              Messages
              {messages.phase === "ready" && messages.rows.length > 0 && (
                <span className="modal-tab-count">{messages.rows.length}</span>
              )}
            </button>
          </div>
        </div>

        {/* Hidden rather than unmounted: tearing the details panel down would
            take the Mapbox instance with it, so every trip back to this tab
            would re-geocode the address and rebuild the map from scratch,
            losing whatever the user had panned or zoomed to. */}
        <div className="modal-body" hidden={tab !== "details"}>
          <div className="modal-field">
            <span className="modal-label">Incident Type</span>
            {inc.type
              ? <span className={`type-tag ${typeClass(inc.type)}`}>{inc.type.toUpperCase()}</span>
              : <span className="dim">—</span>}
          </div>

          <div className="modal-field">
            <span className="modal-label">Address</span>
            <div className="addr-cell">
              <span className="modal-value">{inc.location || <span className="dim">—</span>}</span>
              {inc.coords && (
                <a
                  className="map-link"
                  href={googleMapsHref(inc.coords)}
                  onClick={(e) => openInMaps(e, inc.coords!)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ↗ Maps
                </a>
              )}
            </div>
          </div>

          <div className="modal-field">
            <span className="modal-label">Resources Paged</span>
            <div className="cs-cell">
              {units.length > 0
                ? units.map(u => <UnitBadge key={u.name} unit={u} />)
                : <span className="dim">—</span>}
            </div>
          </div>

          {(inc.coords || inc.location) && (
            <div className="modal-field">
              <span className="modal-label">Map</span>
              <IncidentMap coords={inc.coords} address={inc.location} />
            </div>
          )}
        </div>

        {tab === "messages" && <IncidentMessages state={messages} />}
      </div>
    </div>
  );
}

export default function PagerBoard({
  getToken,
  onSignOut,
}: {
  getToken: () => string | null;
  onSignOut: () => void;
}) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState<Date | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  // Infinite scroll: whether older rows remain to load, and a guard against
  // firing overlapping "load older" fetches. `incidentsRef` mirrors the state
  // so the observer callback always reads the current oldest-row cursor.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const incidentsRef = useRef<Incident[]>([]);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  useEffect(() => { incidentsRef.current = incidents; }, [incidents]);

  // Rows that have just gained a resource, and the timers that will clear them.
  // `seenUnits` is the previous pass's {incident -> units} picture, which the
  // effect below diffs against — null until the first load has been recorded.
  const [flashing, setFlashing] = useState<Set<string>>(() => new Set());
  const seenUnitsRef = useRef<Map<string, Set<string>> | null>(null);
  const flashTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // An incident a notification tap asked us to open, held until it lands on the
  // board (the row may not have loaded yet when the deep link / message arrives).
  const [pendingIncidentNo, setPendingIncidentNo] = useState<string | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Notification taps reach us two ways: a fresh tab opened at ?incident=NNN, or
  // a message from the service worker when it focused an already-open board.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deepLink = params.get("incident");
    if (deepLink) {
      setSearch("");
      setPendingIncidentNo(deepLink);
      // Drop the param so a manual refresh doesn't keep re-opening the card.
      params.delete("incident");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }

    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-incident" && e.data.incidentNo) {
        setSearch("");
        setPendingIncidentNo(String(e.data.incidentNo));
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  // Fetch one page from the members-only API (token attached). Pass the oldest
  // row you have to page backwards; omit it for the newest page. Returns null
  // on any failure so callers can keep the board they already have.
  async function fetchPage(before?: Incident): Promise<Incident[] | null> {
    try {
      const token = getToken();
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) {
        params.set("before", before.receivedAt);
        params.set("beforeId", before.id);
      }
      const res = await fetch(`/api/incidents?${params}`, {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.incidents) ? data.incidents : [];
    } catch {
      return null;
    }
  }

  // Pull the newest page. Used for the first load and every Realtime/poll
  // refresh. A short page means it's the whole table, so treat it as
  // authoritative (reflects deletes/wipes); a full page means more rows exist
  // below, so fold it into the older pages we've already loaded.
  async function refresh() {
    const page = await fetchPage();
    if (!page) return;
    if (page.length < PAGE_SIZE) {
      setIncidents(page);
      setHasMore(false);
    } else {
      setIncidents((prev) => mergeById(prev, page));
      if (incidentsRef.current.length === 0) setHasMore(true);
    }
  }

  // Append the next older page. Fired by the scroll sentinel below.
  async function loadMore() {
    if (loadingRef.current || !hasMore) return;
    const oldest = incidentsRef.current[incidentsRef.current.length - 1];
    if (!oldest) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const page = await fetchPage(oldest);
    if (page) {
      setIncidents((prev) => mergeById(prev, page));
      if (page.length < PAGE_SIZE) setHasMore(false);
    }
    loadingRef.current = false;
    setLoadingMore(false);
  }

  useEffect(() => {
    // Load the board now (no server prefetch — the gate renders us empty).
    refresh();

    // Supabase Realtime — instant push on any INSERT/UPDATE/DELETE.
    const channel = getBrowserClient()
      .channel("incidents-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        () => { refresh(); },
      )
      .subscribe();

    // Fallback heartbeat poll every 30s in case the Realtime socket drops.
    const t = setInterval(refresh, 30_000);

    // A backgrounded PWA freezes its timers and drops the Realtime socket, so it
    // shows stale data the moment it's reopened. Pull fresh on every return to
    // the foreground (and re-subscribe so live updates resume).
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      if (channel.state !== "joined") channel.subscribe();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);

    return () => {
      getBrowserClient().removeChannel(channel);
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let result = incidents.filter(hasIncidentNumber);
    if (q) result = result.filter((i) =>
      `${i.incidentNo} ${i.type} ${i.unit} ${i.location} ${i.raw}`
        .toLowerCase()
        .includes(q)
    );
    return result;
  }, [incidents, search]);

  // Areas offered by the alert-preferences picker: every LGA the loaded
  // incidents mention, commonest first. Built from the board's own rows (not
  // `filtered`, so searching doesn't shrink the list) which guarantees the names
  // are spelled exactly as they arrive over the air. Counted per incident rather
  // than per page, so a job paged to six brigades doesn't read as six jobs.
  const lgaOptions = useMemo(() => {
    const counts = new Map<string, { name: string; seen: Set<string> }>();
    for (const i of incidents) {
      const name = lgaFromLocation(i.location);
      if (!name) continue;
      const key = lgaKey(name);
      if (!counts.has(key)) counts.set(key, { name, seen: new Set() });
      counts.get(key)!.seen.add(i.incidentNo || i.id);
    }
    return [...counts.values()]
      .map(({ name, seen }) => ({ name, count: seen.size }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [incidents]);

  // Merge rows that share the same incident number into one display entry.
  //
  // A row is one {incident, unit}, so its `stoppedAt` belongs to that resource —
  // it colours that badge and leaves the rest of the job alone.
  //
  // The job's own details come from its fullest row, not its newest. The rows
  // disagree about how much of the page they carry: the copy paged to the duty
  // officer often arrives from a feed that drops the coordinates and truncates
  // the address at the suburb. Taking the newest meant a job could show no map
  // pin and a half address while a sibling row had both.
  //
  // The time stays the earliest across the rows — that's when the job started,
  // whichever page happens to describe it best.
  //
  // The type is the one exception to "fullest wins": control re-types a job as it
  // develops (an AFA that turns out to be real is re-paged as a structure fire),
  // and that update usually rides in on a *later, thinner* page than the one the
  // rest of the row comes from. So the type is taken from the most recent page
  // that carried one — see isLaterType().
  const merged = useMemo(() => {
    const map = new Map<
      string,
      { inc: Incident; units: Unit[]; startedAt: string; typedBy: Incident }
    >();
    for (const i of filtered) {
      const key = i.incidentNo || i.id;
      let entry = map.get(key);
      if (!entry) {
        entry = { inc: i, units: [], startedAt: i.receivedAt, typedBy: i };
        map.set(key, entry);
      } else {
        entry.inc = fullerOf(entry.inc, i);
        if (i.receivedAt < entry.startedAt) entry.startedAt = i.receivedAt;
        if (isLaterType(entry.typedBy, i)) entry.typedBy = i;
      }
      for (const name of unitTokens(i.unit)) {
        if (!name) continue;
        const held = entry.units.find((u) => u.name === name);
        if (held) held.stopped ||= i.stoppedAt != null;
        else entry.units.push({ name, stopped: i.stoppedAt != null });
      }
    }
    return [...map.values()].map(({ inc, units, startedAt, typedBy }) => ({
      inc:
        inc.receivedAt === startedAt && inc.type === typedBy.type
          ? inc
          : { ...inc, receivedAt: startedAt, type: typedBy.type },
      units,
    }));
  }, [filtered]);

  // ── flash a job that has just gained a resource ──────────────────────────
  //
  // A job keeps growing after it alerts: control pages more brigades to it
  // minutes later, and the only sign on screen is a badge quietly appearing in a
  // row that's already been read. So the row says so itself — two slow blue
  // pulses, blue rather than red because it means "there's more of this one",
  // not "here's a new emergency".
  //
  // Diffed against `incidents` rather than `merged`, so typing in the search box
  // can't read as resources arriving and leaving. A job seen for the first time
  // never flashes — its first page is a whole row appearing, which is loud
  // enough — and neither does an older page scrolled into view, since that's a
  // key we've never held either.
  useEffect(() => {
    const next = new Map<string, Set<string>>();
    for (const i of incidents) {
      const key = i.incidentNo || i.id;
      let units = next.get(key);
      if (!units) next.set(key, (units = new Set()));
      for (const name of unitTokens(i.unit)) if (name) units.add(name);
    }

    const prev = seenUnitsRef.current;
    seenUnitsRef.current = next;
    if (!prev) return; // first load — nothing to have grown out of

    const grown: string[] = [];
    for (const [key, units] of next) {
      const before = prev.get(key);
      if (!before) continue;
      for (const name of units) {
        if (!before.has(name)) { grown.push(key); break; }
      }
    }
    if (!grown.length) return;

    setFlashing((held) => {
      const updated = new Set(held);
      for (const key of grown) updated.add(key);
      return updated;
    });
    for (const key of grown) {
      const timers = flashTimersRef.current;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        setFlashing((held) => {
          if (!held.has(key)) return held;
          const updated = new Set(held);
          updated.delete(key);
          return updated;
        });
      }, FLASH_MS));
    }
  }, [incidents]);

  // Timers outlive a refresh but must not outlive the board.
  useEffect(() => {
    const timers = flashTimersRef.current;
    return () => { for (const t of timers.values()) clearTimeout(t); };
  }, []);

  // Once a notification's incident has loaded onto the board, pop its card open.
  useEffect(() => {
    if (!pendingIncidentNo) return;
    const entry = merged.find((m) => m.inc.incidentNo === pendingIncidentNo);
    if (entry) {
      setSelected(entry);
      setPendingIncidentNo(null);
    }
  }, [pendingIncidentNo, merged]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof merged>();
    for (const m of merged) {
      const d = dateKey(m.inc.receivedAt);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(m);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [merged]);

  // Load older rows as the sentinel row nears the viewport. `rootMargin` starts
  // the fetch ~600px early so scrolling stays smooth. Re-runs when `hasMore`
  // flips (mounting/unmounting the sentinel) so the observer tracks it.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || search) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  // Re-observe when a load finishes so a still-visible sentinel keeps paging.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, search, loadingMore]);

  return (
    <div className="app">
      {/* header */}
      <header className="topbar">
        <div className="brand">
          <img src="/logo.jpg" alt="BelterHub" />
        </div>

        <div className="topbar-spacer" />

        <label className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch("")}>×</button>
          )}
        </label>

        <Link
          className="raw-btn"
          href="/raw"
          title="Every pager line as it came over the air — including what the board filters out"
        >
          Raw feed
        </Link>

        <EnableAlerts lgaOptions={lgaOptions} />

        <button
          className="signout-btn"
          title="Forget this device — you'll need your invite link again"
          onClick={onSignOut}
        >
          Sign out
        </button>

        <div className="clock">{now ? fmt(now.toISOString(), true) : "--:--:--"}</div>
      </header>


      {/* table */}
      <div className="list-wrap">
        {/* Widths are authoritative here (table-layout: fixed in globals.css),
            so a long incident type can't quietly widen its column at the
            address's expense. Sized from the real traffic: incident numbers run
            to 9 characters, and 4 units covers 90% of jobs. */}
        <table className="board-table">
          <thead>
            <tr>
              <th style={{ width: 92 }}>Incident</th>
              <th style={{ width: 66 }}>Time</th>
              <th>Address</th>
              <th style={{ width: 200 }}>Type</th>
              <th style={{ width: 260 }}>Call Sign</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([date, rows]) => (
              <Fragment key={date}>
                <tr className="date-row">
                  <td colSpan={5}>{date}</td>
                </tr>
                {rows.map((entry) => {
                  const { inc: i, units } = entry;
                  const tc = typeClass(i.type);
                  const { street, locality } = splitAddress(i.location);
                  const key = i.incidentNo || i.id;
                  return (
                    <tr
                      key={key}
                      className={`data-row${flashing.has(key) ? " unit-added" : ""}`}
                    >
                      <td>
                        {i.incidentNo
                          ? <button className="inc-link" onClick={() => setSelected(entry)}>{i.incidentNo}</button>
                          : <span className="dim">—</span>}
                      </td>
                      <td>
                        <span className="time-cell">{fmt(i.receivedAt)}</span>
                      </td>
                      <td>
                        <div className="addr-cell">
                          {/* Text and the Maps chip are siblings so the chip can
                              hold the right-hand end of the cell — otherwise a
                              long address pushes it onto a line of its own. */}
                          <div className="addr-text">
                            {i.location ? (
                              <>
                                <span className="street">{street || i.location}</span>
                                {locality && <span className="locality">{locality}</span>}
                              </>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </div>
                          {i.coords && (
                            <a
                              className="map-link"
                              href={googleMapsHref(i.coords)}
                              onClick={(e) => openInMaps(e, i.coords!)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              ↗ Maps
                            </a>
                          )}
                        </div>
                      </td>
                      <td>
                        {i.type
                          ? <span className={`type-tag ${tc}`} title={i.type}>{i.type.toUpperCase()}</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td>
                        <div className="cs-cell">
                          {units.length > 0
                            ? units.map(u => <UnitBadge key={u.name} unit={u} />)
                            : <span className="dim">—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            {hasMore && !search && (
              <tr ref={sentinelRef} className="load-sentinel">
                <td colSpan={5}>{loadingMore ? "Loading earlier incidents…" : ""}</td>
              </tr>
            )}
          </tbody>
        </table>

        {merged.length === 0 && (
          <div className="empty">
            {search ? `No results for "${search}"` : "No incidents."}
          </div>
        )}
      </div>

      {selected && (
        <IncidentModal
          entry={selected}
          getToken={getToken}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
