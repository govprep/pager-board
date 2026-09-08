"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import dynamic from "next/dynamic";
import logo from "@/public/logo.jpg";
import type { Incident, FireWeather, PagerMessage, RawStatus } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";
import { toIncident } from "@/lib/incident-row";
import { hasIncidentNumber } from "@/lib/parser";
import { dedupeMessages } from "@/lib/incident-messages";
import { lgaFromLocation, lgaKey } from "@/lib/lga";
import {
  mergeById,
  mergeEntries,
  splitAddress,
  typeClass,
  type Entry,
  type Unit,
} from "@/lib/entries";
import { googleMapsHref, openInMaps } from "@/lib/map-links";
import EnableAlerts from "@/components/EnableAlerts";
import { useDialog } from "@/components/use-dialog";
import Clock from "@/components/Clock";
import LiveDot, { type LiveState } from "@/components/LiveDot";
import { fmtTime as fmt, dateKey, relativeAge } from "@/lib/time";
import { pushSupported, isFollowing, followIncident, unfollowIncident } from "@/lib/push-client";

const IncidentMap = dynamic(() => import("@/components/IncidentMap"), {
  ssr: false,
  loading: () => <div className="map-fallback" role="status">Loading map…</div>,
});

// "09/08 14:32:07" — a job's pages can straddle midnight, so the per-incident
// message log carries the date as well as the clock time.
function fmtStamp(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${fmt(iso, true)}`;
}

// How long a flash stays on: three 1.12s blinks. Kept in step with the
// `unit-added-pulse` / `row-new-pulse` animations in globals.css — the class is
// dropped on a timer rather than on animationend so it still clears for someone
// whose reduced-motion setting has turned the animation down.
const FLASH_MS = 3360;

// A job has to have been paged this recently to flash as a new arrival. Rows
// appear on the board for two quite different reasons: one was just paged, and
// one is an older page that scrolling has reached (or a feed re-upserting
// history). Only the first is news, and the only thing separating them is the
// clock. Generous enough to cover a slow source — Telegram relays can run
// minutes behind the air — without ever lighting up a backfill.
const NEW_ROW_MAX_AGE_MS = 10 * 60_000;

// One flash map holds every kind of mark: a whole job that has just arrived or
// just changed (keyed by the incident key alone) and a resource added to a job
// already on the board (keyed by both). An incident key never contains a space —
// it's the incident number, or a row id built from one — so the two can't collide
// even though unit names have spaces of their own ("428 QUEANBEYAN"). The value
// says which flash it is.
function flashKey(incidentKey: string, unit: string): string {
  return `${incidentKey} ${unit}`;
}

// Named for the class each one puts on the element (see globals.css):
//   "arrived" — a job paged just now, flashing as a whole row.
//   "changed" — a job already on the board whose details have moved under it: a
//     re-type, a fuller or corrected address, a resource added or stood down.
//   "added"   — the resource that joined, flashing counter to its row.
type FlashKind = "arrived" | "changed" | "added";

// One job as the last diff pass saw it — everything the board draws that can
// change under it, plus when the job started (which decides whether a job we've
// never held is news or history scrolling into view).
type Seen = {
  units: Set<string>;
  stopped: Set<string>;
  type: string;
  location: string;
  startedAt: string;
};

// How many rows to pull per request. The board loads the newest page first,
// then fetches older pages on scroll (see the IntersectionObserver below).
const PAGE_SIZE = 200;

// A search asks the server for matches across the whole table in one capped
// request rather than paging through them. Searching this board means "find that
// job from Tuesday", not "read every fire of the last year" — and one page needs
// no cursor, so it can't skip a row on a tied timestamp the way a paged search
// would. SEARCH_LIMIT is the API's own ceiling; hitting it is reported rather
// than hidden.
const SEARCH_LIMIT = 500;
const SEARCH_DEBOUNCE_MS = 300;

// How long to wait before re-reading the board after a change that can't be
// applied from its own payload. Long enough that a wipe — one event per deleted
// row — costs a single fetch instead of hundreds.
const REFRESH_DEBOUNCE_MS = 250;

// `flash` marks a resource that has only just been added to the job (see the
// diff in PagerBoard below). The row flashes for the change as well; this badge
// blinks counter to it, so on a job already running six appliances the one that
// just joined is the one thing on the row not doing what the row is doing.
function UnitBadge({ unit, flash = false }: { unit: Unit; flash?: boolean }) {
  return (
    <span
      className={`badge${unit.stopped ? " stopped" : ""}${flash ? " added" : ""}`}
      title={
        unit.stopped
          ? "Stood down — stand-down received for this resource"
          : flash
            ? "Just added to this incident"
            : undefined
      }
    >
      {unit.name}
    </span>
  );
}

// Shown while the first page is in flight. The board can't be prefetched on the
// server (the access gate renders it empty), so without this the first thing a
// cold load says is "No incidents." — which on a board people check to find out
// whether anything is happening is the one wrong answer.
//
// Deliberately not table rows: at phone widths the table is restyled into cards
// by cell position, and placeholder cells would have to play along with a grid
// they aren't part of.
function BoardSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: 8 }, (_, n) => (
        <div className="skeleton-row" key={n}>
          <span className="skeleton-bar w-inc" />
          <span className="skeleton-bar w-time" />
          <span className="skeleton-bar w-type" />
          <span className="skeleton-bar w-units" />
          <span className="skeleton-bar w-addr" />
        </div>
      ))}
    </div>
  );
}

// Per-incident "Follow updates" toggle. Subscribing enables device push (if it
// isn't already) and registers this device to be notified when a unit is added
// to this incident. Hidden entirely when push isn't available.
type FollowState = "loading" | "off" | "on" | "busy" | "unsupported" | "error";

function FollowButton({ incidentNo }: { incidentNo: string }) {
  const [state, setState] = useState<FollowState>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setState("loading");
    setError("");
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    isFollowing(incidentNo).then((f) => {
      if (active) setState(f ? "on" : "off");
    }).catch(() => { if (active) setState("error"); });
    return () => { active = false; };
  }, [incidentNo]);

  if (state === "unsupported") return null;

  async function toggle() {
    const previous = state;
    setError("");
    try {
    if (state === "error") {
      setState("loading");
      setState(await isFollowing(incidentNo) ? "on" : "off");
      return;
    }
    if (state === "on") {
      setState("busy");
      const ok = await unfollowIncident(incidentNo);
      if (!ok) setError("Couldn't change follow settings. Try again.");
      setState(ok ? "off" : "on");
    } else if (state === "off") {
      setState("busy");
      const ok = await followIncident(incidentNo);
      if (!ok) setError("Couldn't follow this incident. Check notification permissions and try again.");
      setState(ok ? "on" : "off");
    }
    } catch {
      setState(previous);
      setError("Couldn't update follow settings. Please try again.");
    }
  }

  const busy = state === "busy" || state === "loading";
  const label =
    state === "on" ? "🔔 Following" :
    state === "error" ? "Retry follow status" :
    busy ? "…" :
    "🔔 Follow updates";

  return (
    <><button
      className={`follow-btn${state === "on" ? " on" : ""}`}
      onClick={toggle}
      disabled={busy}
      title="Get a phone alert when a new unit is added to this incident"
    >
      {label}
    </button>{error && <span className="prefs-warn" role="alert">{error}</span>}</>
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

function IncidentMessages({ state, onRetry }: { state: MessagesState; onRetry: () => void }) {
  if (state.phase === "loading") {
    return <div className="msg-note">Loading messages…</div>;
  }
  if (state.phase === "error") {
    return <div className="msg-note" role="alert">Couldn&apos;t load the messages for this incident. <button className="chip" onClick={onRetry}>Retry</button></div>;
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

type ModalTab = "details" | "weather" | "messages";

// The nearest station's full reading — everything Details only summarises as
// one FBI line. A plain read: nothing here is fetched (it rides in on the
// incident row already), so unlike Messages there's no loading state.
/**
 * What a rating is a rating of: "Forest — Swamp forests".
 *
 * BOM names each fuel twice, once as the fire behaviour model and once as the
 * vegetation it stands for, and the two are sometimes the same word ("Grassland"
 * / "Grasslands Pastures and Crops" is close enough to read as a stutter), so a
 * pair that only repeats itself collapses to one. Empty for rows stamped before
 * these were captured, which the callers render as nothing rather than a dash.
 *
 * Real examples, as they end up beside the number in the modal:
 *   17 — Forest (Shrub grass dry sclerophyll forests)
 *    1 — Grasslands Pastures and Crops
 *   11 — Non combustible (Urban Built up)
 */
// BOM's model names are identifiers as much as labels, so some arrive with an
// underscore in them ("Non_combustible", "Spinifex_woodland"). Stored verbatim;
// tidied here, at the point of display.
function prettyModel(model: string | null): string {
  return (model ?? "").replace(/_/g, " ");
}

/** " (Forest)", or nothing when the row predates the fuel names. */
function fuelSuffix(model: string | null): string {
  return model ? ` (${prettyModel(model)})` : "";
}

function fuelLabel(model: string | null, name: string | null): string {
  const m = prettyModel(model);
  if (!m) return name ?? "";
  if (!name) return m;
  const a = m.toLowerCase();
  const b = name.toLowerCase();
  if (b.startsWith(a) || a.startsWith(b)) return name;
  // Parenthesised, not dashed: the caller already joins this on with a dash.
  return `${m} (${name})`;
}

function FireWeatherPanel({ fw }: { fw: FireWeather }) {
  const primaryFuel = fuelLabel(fw.primaryFuelModel, fw.primaryFuelName);
  const secondaryFuel = fuelLabel(fw.secondaryFuelModel, fw.secondaryFuelName);
  return (
    <div className="modal-body">
      <div className="modal-field">
        <span className="modal-label">Station</span>
        <span className="modal-value">
          {fw.stationName} <span className="dim">({fw.distanceKm} km away)</span>
        </span>
      </div>
      <div className="modal-field">
        <span className="modal-label">Observed</span>
        <span className="modal-value">
          {fmt(fw.observedAt)} <span className="dim">({relativeAge(fw.observedAt)} ago)</span>
        </span>
      </div>
      {/* Split across two rows rather than "23 / 7" on one. The pair is two
          fuels at this one station, and which fuel is which changes with where
          the station is — so the number is only actionable next to the country
          it describes. */}
      <div className="modal-field">
        <span className="modal-label">Primary FBI</span>
        <span className="modal-value">
          {fw.primaryFbi}
          {primaryFuel && <span className="dim"> — {primaryFuel}</span>}
        </span>
      </div>
      <div className="modal-field">
        <span className="modal-label">Secondary FBI</span>
        <span className="modal-value">
          {fw.secondaryFbi}
          {secondaryFuel && <span className="dim"> — {secondaryFuel}</span>}
        </span>
      </div>
      <div className="modal-field">
        <span className="modal-label">Temperature</span>
        <span className="modal-value">
          {fw.tempC != null ? `${fw.tempC}°C` : <span className="dim">—</span>}
        </span>
      </div>
      <div className="modal-field">
        <span className="modal-label">Humidity</span>
        <span className="modal-value">
          {fw.humidityPct != null ? `${fw.humidityPct}%` : <span className="dim">—</span>}
        </span>
      </div>
      <div className="modal-field">
        <span className="modal-label">Wind</span>
        <span className="modal-value">
          {fw.windSpdKmh != null ? (
            <>
              {fw.windDir} {fw.windSpdKmh} km/h
              {fw.windGustKmh != null && <span className="dim"> (gusting {fw.windGustKmh} km/h)</span>}
            </>
          ) : (
            <span className="dim">—</span>
          )}
        </span>
      </div>
    </div>
  );
}

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
  const [messageAttempt, setMessageAttempt] = useState(0);

  const dialogRef = useDialog(onClose);

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
  }, [inc.incidentNo, messageAttempt]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      {/* The fixed height applies only on the message log — see globals.css. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Incident ${inc.incidentNo || "details"}`}
        tabIndex={-1}
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

          <div className="modal-tabs" role="tablist" aria-label="Incident information" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const current = tabs.indexOf(event.target as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
          }}>
            <button
              role="tab"
              id="incident-details-tab"
              aria-controls="incident-details-panel"
              tabIndex={tab === "details" ? 0 : -1}
              aria-selected={tab === "details"}
              className={`modal-tab${tab === "details" ? " on" : ""}`}
              onClick={() => setTab("details")}
            >
              Details
            </button>
            {inc.fireWeather && (
              <button
                role="tab"
                id="incident-weather-tab"
                aria-controls="incident-weather-panel"
                tabIndex={tab === "weather" ? 0 : -1}
                aria-selected={tab === "weather"}
                className={`modal-tab${tab === "weather" ? " on" : ""}`}
                onClick={() => setTab("weather")}
              >
                Weather
              </button>
            )}
            <button
              role="tab"
              id="incident-messages-tab"
              aria-controls="incident-messages-panel"
              tabIndex={tab === "messages" ? 0 : -1}
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
        <div className="modal-body" id="incident-details-panel" role="tabpanel" aria-labelledby="incident-details-tab" tabIndex={0} hidden={tab !== "details"}>
          <div className="modal-field">
            <span className="modal-label">Incident Type</span>
            {inc.type
              ? <span className={`type-tag ${typeClass(inc.type)}`}>{inc.type.toUpperCase()}</span>
              : <span className="dim">—</span>}
          </div>

          {inc.fireWeather && (
            <div className="modal-field">
              <span className="modal-label">Fire Behaviour Index</span>
              <span className="modal-value">
                {/* The fuel model only ("Forest"), not the full vegetation
                    name — this is the one-line summary, and the Weather tab
                    carries the long form. */}
                {inc.fireWeather.primaryFbi} primary
                {inc.fireWeather.primaryFuelModel && ` (${inc.fireWeather.primaryFuelModel})`}
                {" / "}
                {inc.fireWeather.secondaryFbi} secondary
                {inc.fireWeather.secondaryFuelModel && ` (${inc.fireWeather.secondaryFuelModel})`}
                <span className="dim"> — {inc.fireWeather.stationName} ({inc.fireWeather.distanceKm} km)</span>
                <span className="dim">
                  {" "}· observation {relativeAge(inc.fireWeather.observedAt)} old ({fmt(inc.fireWeather.observedAt)})
                </span>
              </span>
            </div>
          )}

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

        {inc.fireWeather && <div id="incident-weather-panel" role="tabpanel" aria-labelledby="incident-weather-tab" tabIndex={0} hidden={tab !== "weather"}><FireWeatherPanel fw={inc.fireWeather} /></div>}

        <div className="messages-panel" id="incident-messages-panel" role="tabpanel" aria-labelledby="incident-messages-tab" tabIndex={0} hidden={tab !== "messages"}><IncidentMessages state={messages} onRetry={() => setMessageAttempt((n) => n + 1)} /></div>
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
  const [selected, setSelected] = useState<Entry | null>(null);
  // False only until the first page lands — an empty board and a board that
  // hasn't answered yet are different things, and "No incidents." is a lie about
  // the second one.
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState("");
  const [pageError, setPageError] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const refreshSequence = useRef(0);
  const realtimeRevision = useRef(0);
  // Whether the Realtime socket is joined. When it isn't, the board is running on
  // the 30s heartbeat below, and the topbar says so rather than leaving a stalled
  // board looking like a quiet one.
  const [live, setLive] = useState<LiveState>("connecting");
  // Infinite scroll: whether older rows remain to load, and a guard against
  // firing overlapping "load older" fetches. `incidentsRef` mirrors the state
  // so the observer callback always reads the current oldest-row cursor.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const incidentsRef = useRef<Incident[]>([]);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);
  const topbarRef = useRef<HTMLElement | null>(null);
  // Mirrored for the Realtime handler, which is registered once on mount and so
  // would otherwise close over the first render's `hasMore`.
  const hasMoreRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whole-table search results, kept apart from `incidents` on purpose: they're
  // history being looked up, not traffic arriving, so they must not reach the
  // flash diff below (an hour of matches landing at once would read as an hour of
  // jobs being paged at once) and must not become the paging cursor.
  const [query, setQuery] = useState("");            // debounced copy of `search`
  const [found, setFound] = useState<Incident[]>([]);
  const [searching, setSearching] = useState(false);
  const [foundCapped, setFoundCapped] = useState(false);

  useEffect(() => { incidentsRef.current = incidents; }, [incidents]);
  useEffect(() => { hasMoreRef.current = hasMore; }, [hasMore]);

  // What's currently flashing and how, and the timers that will clear it.
  // `seenRef` is the previous pass's picture of the board — which jobs were on
  // it, what each said, which resources each had and which of those were stood
  // down — for the effect below to diff against. Null until the first load has
  // been recorded.
  const [flashing, setFlashing] = useState<Map<string, FlashKind>>(() => new Map());
  const seenRef = useRef<Map<string, Seen> | null>(null);
  const flashTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Set for the one board change that is never news: the older page a scroll
  // just pulled in. See the diff effect below.
  const pagedInRef = useRef(false);

  // An incident a notification tap asked us to open, held until it lands on the
  // board (the row may not have loaded yet when the deep link / message arrives).
  const [pendingIncidentNo, setPendingIncidentNo] = useState<string | null>(null);

  // The incident card sits below the topbar, and the topbar has no single height
  // to hard-code: it wraps to a second row on a phone, and grows again by the
  // status-bar inset once the PWA is installed. Measured and published as a
  // custom property so the overlay and the modal's max-height track it (see
  // globals.css) instead of assuming the desktop 50px.
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const publish = () => {
      document.documentElement.style.setProperty(
        "--topbar-h",
        `${Math.round(el.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const obs = new ResizeObserver(publish);
    obs.observe(el);
    return () => obs.disconnect();
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

  // Fetch from the members-only API (token attached). Pass the oldest row you
  // have to page backwards; omit it for the newest page. Pass a term to search
  // the whole table instead of a page of it. Returns null on any failure so
  // callers can keep the board they already have.
  async function fetchPage(
    before?: Incident,
    term?: string,
  ): Promise<Incident[] | null> {
    try {
      const token = getToken();
      const params = new URLSearchParams({
        limit: String(term ? SEARCH_LIMIT : PAGE_SIZE),
      });
      if (before) {
        params.set("before", before.receivedAt);
        params.set("beforeId", before.id);
      }
      if (term) params.set("q", term);
      const res = await fetch(`/api/incidents?${params}`, {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.incidents) ? data.incidents : null;
    } catch {
      return null;
    }
  }

  // Pull the newest page. Used for the first load and every Realtime/poll
  // refresh. A short page means it's the whole table, so treat it as
  // authoritative (reflects deletes/wipes); a full page means more rows exist
  // below, so fold it into the older pages we've already loaded.
  async function refresh() {
    const sequence = ++refreshSequence.current;
    const revision = realtimeRevision.current;
    const page = await fetchPage();
    if (sequence !== refreshSequence.current) return;
    setLoading(false);
    if (!page) { setFeedError("Couldn't refresh incidents. Check your connection and try again."); return; }
    setFeedError("");
    // An older HTTP snapshot must not overwrite a newer live update.
    if (revision !== realtimeRevision.current) { scheduleRefresh(); return; }
    if (page.length < PAGE_SIZE) {
      setIncidents(page);
      setHasMore(false);
    } else {
      setIncidents((prev) => mergeById(prev, page));
      if (incidentsRef.current.length === 0) setHasMore(true);
    }
  }

  // Fold one row straight into the board. A Realtime payload carries the whole
  // row, so an arriving page needs no round trip at all — the fetch it used to
  // trigger cost a request per event, and a job paged to six brigades is six
  // events inside a couple of seconds.
  //
  // The one row not to apply is one older than everything currently loaded and
  // not already held: the board holds the newest page and fetches older ones on
  // scroll, so dropping such a row in would seat it directly under the oldest
  // row on screen as though nothing lay between them. That's a backfill
  // re-upserting history rather than a job being paged; the scroll fetch will
  // find it in its proper place.
  function applyRow(inc: Incident) {
    realtimeRevision.current += 1;
    setIncidents((prev) => {
      const oldest = prev[prev.length - 1];
      const known = prev.some((p) => p.id === inc.id);
      if (!known && hasMoreRef.current && oldest && (inc.receivedAt < oldest.receivedAt || (inc.receivedAt === oldest.receivedAt && inc.id < oldest.id))) {
        return prev;
      }
      return mergeById(prev, [inc]);
    });
  }

  // A DELETE payload carries only the primary key, so a wipe is the one change
  // that still needs the board re-read — coalesced, since a wipe arrives as one
  // event per row.
  function scheduleRefresh() {
    if (refreshTimerRef.current) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  // Append the next older page. Fired by the scroll sentinel below.
  async function loadMore() {
    if (loadingRef.current || !hasMore) return;
    const sequence = refreshSequence.current;
    const revision = realtimeRevision.current;
    const oldest = incidentsRef.current[incidentsRef.current.length - 1];
    if (!oldest) return;
    loadingRef.current = true;
    setLoadingMore(true);
    const page = await fetchPage(oldest);
    if (sequence !== refreshSequence.current || revision !== realtimeRevision.current) {
      loadingRef.current = false;
      setLoadingMore(false);
      return;
    }
    setPageError(!page);
    if (page) {
      // Older pages are history reaching the board, not traffic arriving on it —
      // told to the flash diff here rather than guessed at there, since a page
      // this far back can still change what a loaded job says (see the effect).
      pagedInRef.current = true;
      setIncidents((prev) => mergeById(page, prev));
      if (page.length < PAGE_SIZE) setHasMore(false);
    }
    loadingRef.current = false;
    setLoadingMore(false);
  }

  // Debounce the box, so a search is one request per pause rather than one per
  // keystroke. The typed value still filters the loaded rows immediately (see
  // `filtered`) — this only governs when the rest of the table is asked.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  // Search the whole table. Without this the board's filter could only ever see
  // its loaded rows, so "no results" really meant "not in the newest 200" — and
  // scrolling for more was disabled while searching, so there was no way to find
  // out otherwise.
  useEffect(() => {
    setSearchError(false);
    if (!query) {
      setFound([]);
      setSearching(false);
      setFoundCapped(false);
      return;
    }
    let active = true;
    setSearching(true);
    (async () => {
      const rows = await fetchPage(undefined, query);
      if (!active) return;
      setFound(rows ?? []);
      setSearchError(!rows);
      setFoundCapped((rows?.length ?? 0) >= SEARCH_LIMIT);
      setSearching(false);
    })();
    return () => { active = false; };
  // getToken is a fresh closure on every render, and fetchPage closes over it;
  // keying on the query alone is what keeps this to one request per search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchAttempt]);

  useEffect(() => {
    // Load the board now (no server prefetch — the gate renders us empty).
    refresh();

    // Supabase Realtime — instant push on any INSERT/UPDATE/DELETE. The row
    // rides along with the event, so INSERT/UPDATE go straight onto the board;
    // only a DELETE (primary key only) has to ask the server anything.
    const channel = getBrowserClient()
      .channel("incidents-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        (payload) => {
          const row = payload.eventType === "DELETE" ? null : payload.new;
          if (row && typeof row.id === "string") applyRow(toIncident(row));
          else { realtimeRevision.current += 1; scheduleRefresh(); }
        },
      )
      .subscribe();

    // The live readout is *read* from the channel rather than pushed to us by its
    // subscribe callback. Strict Mode mounts this effect twice, so the callback
    // belonging to the channel we just removed could land after the replacement's
    // — and since a joined channel never reports again, that pinned the readout to
    // "reconnecting" on a board that was being pushed to perfectly well. Polling a
    // property can't be raced by anything, and it self-heals within one tick
    // whatever the socket does.
    const readState = () => {
      const s = channel.state;
      setLive(s === "joined" ? "live" : s === "joining" ? "connecting" : "down");
    };
    const liveTimer = setInterval(readState, 2_000);

    // Fallback heartbeat poll every 30s in case the Realtime socket drops.
    const t = setInterval(refresh, 30_000);

    // A backgrounded PWA freezes its timers and drops the Realtime socket, so it
    // shows stale data the moment it's reopened. Pull fresh on every return to
    // the foreground (and re-subscribe so live updates resume).
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      if (channel.state !== "joined") channel.subscribe();
      readState();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);

    return () => {
      refreshSequence.current += 1;
      getBrowserClient().removeChannel(channel);
      clearInterval(t);
      clearInterval(liveTimer);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the board shows. The typed text filters immediately — that's what makes
  // the box feel like it's responding to the keystroke — and the server's matches
  // for the whole table are folded into the same pool as they arrive, so the list
  // fills in downwards rather than being replaced. Every row still has to pass
  // the same local predicate, so a server match and a loaded match are held to
  // one standard.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = q && found.length > 0 ? mergeById(incidents, found) : incidents;
    let result = pool.filter(hasIncidentNumber);
    if (q) result = result.filter((i) =>
      `${i.incidentNo} ${i.type} ${i.unit} ${i.location} ${i.raw}`
        .toLowerCase()
        .includes(q)
    );
    return result;
  }, [incidents, found, search]);

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

  // What's on the board: one entry per job (see mergeEntries above).
  const merged = useMemo(() => mergeEntries(filtered), [filtered]);

  // ── flash what has just changed ──────────────────────────────────────────
  //
  // A live board changes under the person reading it, and every change says so in
  // the same idiom: three hard blue blinks on the same beat, blue because red on
  // this board means stood down.
  //
  // The row is what flashes, for a job just paged and for a job that has changed
  // alike — a re-type, an address that has come through fuller or been corrected,
  // a resource added, a resource stood down. It's the row that's different, and it
  // sits in a list nobody may be looking at.
  //
  // A resource that has just been added flashes too, but *counter* to its row:
  // lit while the row is dark and dark while the row is lit (see globals.css). A
  // badge blinking in step with its row would just be part of the wash, and on a
  // job already running six appliances the whole question is which one joined.
  //
  // Diffed against `incidents` rather than `merged`, so typing in the search box —
  // which folds whole-table matches into the merged view — can't read as jobs and
  // resources arriving. Through mergeEntries, so what's compared is what's drawn:
  // the type and address on screen are reconciled across a job's rows, and
  // diffing the rows themselves would miss a re-type that arrives on a page the
  // board doesn't show.
  //
  // Two things that are not news are held back. A job we've never held has to be
  // *recent* to flash, because reaching an older page by scrolling also produces
  // keys we've never held. And a scroll-load is skipped outright: pulling in a
  // job's older sibling rows can hand the reconciliation above a fuller address
  // for a job already on the board, which is a page from an hour ago arriving,
  // not the job changing.
  useEffect(() => {
    // Nothing has arrived yet, so there is no picture to remember. Without this
    // the baseline is taken on the render *before* the first page lands — an
    // empty board — and every job on that page then reads as one that has just
    // been paged. Refreshing the board flashed the last few jobs every time.
    if (loading) return;

    const next = new Map<string, Seen>();
    for (const { key, inc, units } of mergeEntries(incidents)) {
      next.set(key, {
        units: new Set(units.map((u) => u.name)),
        stopped: new Set(units.filter((u) => u.stopped).map((u) => u.name)),
        type: inc.type,
        location: inc.location,
        startedAt: inc.receivedAt,
      });
    }

    const prev = seenRef.current;
    seenRef.current = next;
    const backfilled = pagedInRef.current;
    pagedInRef.current = false;
    if (!prev) return;      // first load — the whole board would be "new"
    if (backfilled) return; // history, now recorded, but nothing to announce

    const cutoff = Date.now() - NEW_ROW_MAX_AGE_MS;
    const marks = new Map<string, FlashKind>();
    for (const [key, now] of next) {
      const before = prev.get(key);
      if (!before) {
        if (new Date(now.startedAt).getTime() >= cutoff) marks.set(key, "arrived");
        continue;
      }
      // A job we already had: what about it is different.
      let changed = now.type !== before.type || now.location !== before.location;
      for (const name of now.units) {
        if (before.units.has(name)) continue;
        marks.set(flashKey(key, name), "added");
        changed = true;
      }
      for (const name of now.stopped) if (!before.stopped.has(name)) changed = true;
      if (changed) marks.set(key, "changed");
    }
    if (!marks.size) return;

    setFlashing((held) => {
      const updated = new Map(held);
      for (const [key, kind] of marks) updated.set(key, kind);
      return updated;
    });
    for (const key of marks.keys()) {
      const timers = flashTimersRef.current;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        setFlashing((held) => {
          if (!held.has(key)) return held;
          const updated = new Map(held);
          updated.delete(key);
          return updated;
        });
      }, FLASH_MS));
    }
  }, [incidents, loading]);

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
    if (!el || !hasMore || search || pageError) return;
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: "600px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  // Re-observe when a load finishes so a still-visible sentinel keeps paging.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, search, loadingMore, pageError]);

  return (
    <div className="app">
      {/* header */}
      <header className="topbar" ref={topbarRef}>
        <div className="brand">
          <Image src={logo} alt="BelterHub" sizes="160px" />
        </div>

        <div className="topbar-spacer" />

        <label className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            aria-label="Search every incident"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search every incident…"
            enterKeyHint="search"
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch("")} aria-label="Clear search">×</button>
          )}
        </label>

        <Link
          className="raw-btn"
          href="/map"
          title="Every job of the last few hours, on a map"
        >
          Map
        </Link>

        <Link
          className="raw-btn"
          href="/raw"
          title="Every pager line as it came over the air — including what the board filters out"
        >
          {/* Icon for the phone, words for the pointer. The label isn't dropped
              when the icon takes over — it's clipped, so it stays the button's
              accessible name. */}
          <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="4 7 8 12 4 17" /><line x1="12" y1="17" x2="20" y2="17" />
          </svg>
          <span className="btn-label">Raw feed</span>
        </Link>

        <EnableAlerts lgaOptions={lgaOptions} />

        <button
          className="signout-btn"
          title="Forget this device — you'll need your invite link again"
          onClick={onSignOut}
        >
          <svg className="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18.36 6.64a9 9 0 1 1-12.72 0" /><line x1="12" y1="2" x2="12" y2="12" />
          </svg>
          <span className="btn-label">Sign out</span>
        </button>

        {/* Where the phone header breaks. A wrapped flex row breaks on width
            alone — `order` sorts items but never starts a new line — so without
            a full-width item here the controls above spilled into the search's
            row and pushed the clock onto a row of its own. */}
        <div className="topbar-break" aria-hidden="true" />

        <LiveDot state={live} />
        <Clock />
      </header>


      {/* A search is answered from the whole table, so say where the answer
          stands: still being looked up, complete, or capped. Above the results
          rather than under them — the point of a cap is to be read before you
          conclude the older job you're after doesn't exist. Outside the scrolling
          list so it stays put while you read down the matches. */}
      {feedError && <div className="feed-error" role="alert">{feedError} <button className="chip" onClick={() => void refresh()}>Retry</button></div>}
      {searchError && search && <div className="feed-error" role="alert">Couldn't search all incidents. <button className="chip" onClick={() => setSearchAttempt((n) => n + 1)}>Retry search</button></div>}
      {search && merged.length > 0 && !searchError && (
        <div className="search-note">
          {searching
            ? "Searching every incident…"
            : foundCapped
              ? `Newest ${SEARCH_LIMIT} matches shown — narrow the search to reach older ones`
              : `${merged.length} ${merged.length === 1 ? "incident" : "incidents"} matching “${search}”`}
        </div>
      )}

      {/* table */}
      <div className="list-wrap">
        {/* Widths are authoritative here (table-layout: fixed in globals.css),
            so a long incident type can't quietly widen its column at the
            address's expense. Sized from the real traffic: incident numbers run
            to 9 characters, and 4 units covers 90% of jobs.

            Address is deliberately last, and is the one column left to take
            whatever is over. Most of the traffic is FRNSW, whose pages carry no
            address at all — the whole line is
            "FRINC TYPE: AFA TURNOUT: 66 INC: 156572" — so when Address sat in
            the middle at full flex it left a void across most of the board
            while the columns that always have something to say were squeezed
            against the right edge, wrapping the resources onto three lines.
            Sitting last, the space it can't use is simply the end of the row.

            Call Sign is a percentage rather than a fixed width so it keeps its
            share on a laptop instead of collapsing back to a wrapping column;
            ~32% fits six badges, which covers all but the largest turnouts. */}
        <table className="board-table">
          <thead>
            <tr>
              <th style={{ width: 92 }}>Incident</th>
              <th style={{ width: 66 }}>Time</th>
              <th style={{ width: 200 }}>Type</th>
              {/* Wide enough for the badge it holds, which is the thing this
                  column is. "100 / 100" is 9 monospace characters, and the
                  badge adds its own padding and border around them — at 64 the
                  cell had 36px of content box for ~83px of badge, so every FBI
                  on the board hung out over the Call Sign column instead of
                  sitting under its own heading. Its cells take the tighter
                  8px side padding in globals.css to spend less of the width on
                  air. */}
              <th style={{ width: 104 }}>FBI</th>
              <th style={{ width: "32%" }}>Call Sign</th>
              <th>Address</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([date, rows]) => (
              <Fragment key={date}>
                <tr className="date-row">
                  <td colSpan={6}>{date}</td>
                </tr>
                {rows.map((entry) => {
                  const { key, inc: i, units } = entry;
                  const tc = typeClass(i.type);
                  const { street, locality } = splitAddress(i.location);
                  const flash = flashing.get(key);
                  const open = i.incidentNo ? () => setSelected(entry) : undefined;
                  return (
                    <tr
                      key={key}
                      className={`data-row${open ? " clickable" : ""}${
                        flash === "arrived" || flash === "changed" ? ` ${flash}` : ""
                      }`}
                      onClick={open ? (e) => {
                        // A drag that ended up selecting the address was a read,
                        // not a tap — don't answer it by throwing a card over the
                        // thing being read.
                        if (!window.getSelection()?.isCollapsed) return;
                        // Let a real control inside the row do its own job.
                        if ((e.target as HTMLElement).closest("a, button")) return;
                        open();
                      } : undefined}
                    >
                      <td>
                        {i.incidentNo
                          ? <button className="inc-link" onClick={open} aria-label={`Open incident ${i.incidentNo}`}>{i.incidentNo}</button>
                          : <span className="dim">—</span>}
                      </td>
                      <td>
                        <span className="time-cell">{fmt(i.receivedAt)}</span>
                      </td>
                      <td>
                        {i.type
                          ? <span className={`type-tag ${tc}`} title={i.type}>{i.type.toUpperCase()}</span>
                          : <span className="dim">—</span>}
                      </td>
                      <td>
                        {/* No dash placeholder here, unlike the other columns —
                            this only applies to a small slice of jobs, and a
                            "—" on every AFA/MVA/structure fire would just be
                            noise repeated down the whole board. */}
                        {i.fireWeather && (
                          <span
                            className="fbi-tag"
                            title={[
                              // Which half of the badge is which — the column
                              // is too narrow to say so, and the pair of fuels
                              // differs from station to station.
                              `${i.fireWeather.primaryFbi} primary${fuelSuffix(i.fireWeather.primaryFuelModel)}`,
                              `${i.fireWeather.secondaryFbi} secondary${fuelSuffix(i.fireWeather.secondaryFuelModel)}`,
                              `${i.fireWeather.stationName} · ${i.fireWeather.distanceKm} km away`,
                              `observation ${relativeAge(i.fireWeather.observedAt)} old`,
                            ].join("\n")}
                          >
                            {i.fireWeather.primaryFbi} / {i.fireWeather.secondaryFbi}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="cs-cell">
                          {units.length > 0
                            ? units.map(u => (
                                <UnitBadge
                                  key={u.name}
                                  unit={u}
                                  flash={flashing.get(flashKey(key, u.name)) === "added"}
                                />
                              ))
                            : <span className="dim">—</span>}
                        </div>
                      </td>
                      <td>
                        <div className="addr-cell">
                          {/* Text and the Maps chip are siblings so the chip is
                              a fixed-size block rather than another wrapping
                              word — a long address wraps inside its own box
                              instead of pushing the chip onto a line of its
                              own. The chip follows the text rather than holding
                              the far edge: this column now runs to the end of
                              the window, and pinning it right would strand it
                              half a screen from the address it belongs to. */}
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
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            {hasMore && !search && (
              <tr ref={sentinelRef} className="load-sentinel">
                <td colSpan={6}>{pageError ? <button className="chip" onClick={() => void loadMore()}>Couldn't load earlier incidents. Retry</button> : loadingMore ? "Loading earlier incidents…" : ""}</td>
              </tr>
            )}
          </tbody>
        </table>

        {loading && merged.length === 0 ? (
          <BoardSkeleton />
        ) : merged.length === 0 && !feedError && !searchError ? (
          <div className="empty">
            {searching
              ? "Searching every incident…"
              : search
                ? `No results for "${search}"`
                : "No incidents."}
          </div>
        ) : null}
      </div>

      {selected && (
        <IncidentModal
          key={selected.inc.id}
          entry={selected}
          getToken={getToken}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
