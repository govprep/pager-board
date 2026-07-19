"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Incident } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";
import { hasIncidentNumber } from "@/lib/parser";
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

type Entry = { inc: Incident; units: string[]; stopped: boolean };

function StopFlag() {
  return <span className="stop-flag" title="Stand-down received for this incident">STOP</span>;
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

function IncidentModal({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { inc, units, stopped } = entry;

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-inc-group">
            <span className="modal-inc">{inc.incidentNo || "Incident"}</span>
            {stopped && <StopFlag />}
          </div>
          <div className="modal-head-actions">
            {inc.incidentNo && <FollowButton incidentNo={inc.incidentNo} />}
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="modal-body">
          <div className="modal-field">
            <span className="modal-label">Incident Type</span>
            {inc.type
              ? <span className={`type-tag ${typeClass(inc.type)}`}>{inc.type.toUpperCase()}</span>
              : <span className="dim">—</span>}
          </div>

          <div className="modal-field">
            <span className="modal-label">Address</span>
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

          <div className="modal-field">
            <span className="modal-label">Resources Assigned</span>
            <div className="cs-cell">
              {units.length > 0
                ? units.map(u => <span key={u} className="badge">{u}</span>)
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

  // Merge rows that share the same incident number into one display entry.
  const merged = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const i of filtered) {
      const key = i.incidentNo || i.id;
      if (!map.has(key)) map.set(key, { inc: i, units: [], stopped: false });
      const entry = map.get(key)!;
      for (const u of unitTokens(i.unit)) {
        if (u && !entry.units.includes(u)) entry.units.push(u);
      }
      if (i.stoppedAt) entry.stopped = true;
      if (i.receivedAt < entry.inc.receivedAt) entry.inc = { ...entry.inc, receivedAt: i.receivedAt };
    }
    return [...map.values()];
  }, [filtered]);

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

        <EnableAlerts />

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
        <table>
          <thead>
            <tr>
              <th style={{ width: 120 }}>Incident</th>
              <th style={{ width: 60 }}>Time</th>
              <th>Address</th>
              <th style={{ width: 160 }}>Type</th>
              <th style={{ width: 240 }}>Call Sign</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([date, rows]) => (
              <Fragment key={date}>
                <tr className="date-row">
                  <td colSpan={5}>{date}</td>
                </tr>
                {rows.map((entry) => {
                  const { inc: i, units, stopped } = entry;
                  const tc = typeClass(i.type);
                  const { street, locality } = splitAddress(i.location);
                  const key = i.incidentNo || i.id;
                  return (
                    <tr key={key} className={`data-row${stopped ? " stopped" : ""}`}>
                      <td>
                        {i.incidentNo
                          ? <button className="inc-link" onClick={() => setSelected(entry)}>{i.incidentNo}</button>
                          : <span className="dim">—</span>}
                        {stopped && <StopFlag />}
                      </td>
                      <td>
                        <span className="time-cell">{fmt(i.receivedAt)}</span>
                      </td>
                      <td>
                        <div className="addr-cell">
                          {i.location ? (
                            <>
                              <span className="street">{street || i.location}</span>
                              {locality && <span className="locality">{locality}</span>}
                            </>
                          ) : (
                            <span className="dim">—</span>
                          )}
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
                          ? <span className={`type-tag ${tc}`}>{i.type.toUpperCase()}</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td>
                        <div className="cs-cell">
                          {units.length > 0
                            ? units.map(u => <span key={u} className="badge">{u}</span>)
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
        <IncidentModal entry={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
