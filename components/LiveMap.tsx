"use client";

// The live map — every job paged in the last few hours, where it happened.
//
// The board answers "what is running"; this answers "where". It is the same
// data, reconciled the same way (lib/entries.ts), on the same Realtime socket:
// a page lands here the moment it lands there.
//
// Two things about the traffic shape this whole file:
//
//   · Most of it is FRNSW, and a FRNSW page carries no address and no
//     coordinates — only the turnout number of the station that was sent. Those
//     jobs are placed on the station's suburb and drawn as a soft ring rather
//     than a pin, with the card saying so in words. See lib/incident-points.ts.
//   · A job is one dot, not one dot per appliance. Six brigades on one fire is
//     six rows in the table and one marker here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import mapboxgl from "mapbox-gl";
import type { GeoJSONSource } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import logo from "@/public/logo.jpg";
import type { Coords, Incident } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";
import { toIncident } from "@/lib/incident-row";
import { hasIncidentNumber } from "@/lib/parser";
import { mergeById, mergeEntries, splitAddress, typeClass, type Entry } from "@/lib/entries";
import { placeJob } from "@/lib/incident-points";
import { cachedGeocode, forwardGeocode } from "@/lib/geocode";
import { googleMapsHref, openInMaps } from "@/lib/map-links";
import { lgaFromLocation, lgaKey } from "@/lib/lga";
import EnableAlerts from "@/components/EnableAlerts";
import Clock from "@/components/Clock";
import LiveDot, { type LiveState } from "@/components/LiveDot";
import { fmtTime as fmt, relativeAge } from "@/lib/time";

// ── what the map holds ──────────────────────────────────────────────────────

// The windows offered, and the one a first visit gets. Four hours is a shift's
// worth of traffic: long enough that a quiet afternoon still has something on
// it, short enough that what's there is current.
const WINDOWS = [1, 4, 12, 24] as const;
const DEFAULT_WINDOW = 4;

const PAGE_SIZE = 200;
// A ceiling on how far back one window change will page. 24 hours of a busy day
// is a few hundred jobs; this is the guard against a runaway loop, not a budget.
const MAX_PAGES = 8;

// How often the clock-driven parts re-read (ages, the window's own cutoff, the
// heat weights). Coarse on purpose — nothing here is displayed to the second.
const TICK_MS = 30_000;

// A job has to have started this recently to count as news rather than as
// history arriving. Same reasoning, and the same number, as the board's flash.
const NEW_JOB_MAX_AGE_MS = 10 * 60_000;
// How long a new job keeps its pulse ring, and how long its toast stays up.
const PULSE_MS = 120_000;
const TOAST_MS = 20_000;

const STORE = {
  window: "belterhub.map.window",
  heat: "belterhub.map.heat",
  sound: "belterhub.map.sound",
  basemap: "belterhub.map.basemap",
};

// Where the map opens before there is anything to fit to: the NSW/ACT corner the
// feed actually covers, not the middle of the continent.
const HOME: { center: [number, number]; zoom: number } = {
  center: [150.6, -33.6],
  zoom: 5.4,
};

const STYLES = {
  dark: "mapbox://styles/mapbox/dark-v11",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
} as const;
type BaseMap = keyof typeof STYLES;

// Dot colours, keyed by the same classes the board's type tags use
// (lib/entries.ts) so a fire is red in both places.
//
// Automatic alarms are the one departure. On the board they're a grey chip,
// which is right in a list — an AFA is the least of the traffic. On a black map
// grey reads as "switched off", and AFAs are a large share of what's on screen,
// so they take a colour of their own here.
const TYPE_COLOR: Record<string, string> = {
  fire: "#ef4444",
  rescue: "#fb923c",
  hazmat: "#facc15",
  medical: "#4ade80",
  storm: "#38bdf8",
  afa: "#a78bfa",
  default: "#94a3b8",
};

// The key, in the order it reads best: what you're most likely to be looking for
// at the top.
const LEGEND: { cls: string; label: string }[] = [
  { cls: "fire", label: "Fire" },
  { cls: "rescue", label: "Rescue / MVA" },
  { cls: "hazmat", label: "Hazmat" },
  { cls: "medical", label: "Medical" },
  { cls: "storm", label: "Storm / flood" },
  { cls: "afa", label: "Automatic alarm" },
  { cls: "default", label: "Other" },
];

// Two sources over the same features. Clustering is what keeps a busy hour
// legible at state zoom, but a clustered source has nothing left to make a heat
// map out of — the points have already been collapsed — so the heat layer and
// the new-job pulse read the plain one.
const SRC = { plain: "jobs", clustered: "jobs-clustered" };
const LYR = {
  heat: "jobs-heat",
  approx: "jobs-approx",
  pulse: "jobs-pulse",
  clusters: "jobs-clusters",
  clusterCount: "jobs-cluster-count",
  point: "jobs-point",
  selected: "jobs-selected",
  label: "jobs-label",
};

// ── the pins ────────────────────────────────────────────────────────────────

// One job, placed. `precision` is how much the position is worth: "exact" came
// off the page, the other two were looked up from text.
type Placed = {
  entry: Entry;
  coords: Coords;
  precision: "exact" | "station" | "address";
  /** What to call the place on the card — the address, or the station suburb. */
  place: string;
};

type JobFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: Record<string, string | number | boolean>;
};

// A stable, small offset for a job we only know the suburb of.
//
// Every FRNSW job in Queanbeyan geocodes to the *same* point, so a busy suburb
// stacks four markers into one and the count on screen is a lie. Fanning them
// out by a couple of hundred metres tells the truth better than stacking does —
// these markers already say "somewhere around here" — and being a hash of the
// job's own key rather than a random number, a job doesn't hop about between
// renders.
function scatter(key: string, coords: Coords): Coords {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const angle = ((hash >>> 0) % 360) * (Math.PI / 180);
  // 60–260 m, expressed in degrees at NSW latitudes.
  const metres = 60 + ((hash >>> 9) % 200);
  const dLat = (metres * Math.cos(angle)) / 111_320;
  const dLng = (metres * Math.sin(angle)) / (111_320 * Math.cos((coords.lat * Math.PI) / 180));
  return { lng: coords.lng + dLng, lat: coords.lat + dLat };
}

// What a click hands back.
//
// mapbox-gl types its features as extending GeoJSON.Feature, and @types/geojson
// isn't a dependency here, so the inherited members aren't visible to
// TypeScript at all. Rather than widen every handler, the two fields actually
// read are named once and the feature is passed through this.
type ClickedFeature = {
  properties?: Record<string, unknown>;
  geometry?: { coordinates?: [number, number] };
};

function clicked(feature: unknown): ClickedFeature | undefined {
  return feature as ClickedFeature | undefined;
}

function featureFor(placed: Placed, now: number, windowMs: number, fresh: boolean): JobFeature {
  const { entry, coords, precision } = placed;
  const started = new Date(entry.inc.receivedAt).getTime();
  const age = Math.max(0, now - started);
  const point = precision === "exact" ? coords : scatter(entry.key, coords);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [point.lng, point.lat] },
    properties: {
      key: entry.key,
      color: TYPE_COLOR[typeClass(entry.inc.type)] ?? TYPE_COLOR.default,
      precision,
      fresh,
      // Newest jobs burn hottest, so the heat map of a 24-hour window still
      // shows where the last hour was rather than an even wash over the day.
      weight: Math.max(0.2, 1 - age / windowMs),
      label: entry.inc.type ? entry.inc.type.toUpperCase() : entry.inc.incidentNo,
    },
  };
}

// A two-note chime for a new job. Synthesised rather than shipped as an audio
// file: it's two oscillators and no request, and there's no media element for a
// browser to block. The context is created on the tap that turns sound on,
// which is the gesture browsers require before anything may make a noise.
function makeChime(): () => void {
  let ctx: AudioContext | null = null;
  return () => {
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
      const at = ctx.currentTime;
      for (const [i, freq] of [880, 1320].entries()) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = at + i * 0.16;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.36);
      }
    } catch {
      // No audio output, or a context the browser refused — silence is fine.
    }
  };
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A device that can't persist a preference still gets it for this session.
  }
}

// ── the card ────────────────────────────────────────────────────────────────

// The mini card a marker opens: enough to decide whether this is the job you
// were looking for, and a way through to the board's full record of it.
//
// On a phone it's a bottom sheet — thumbs are at the bottom of the screen and
// the top half of the map is the part worth keeping visible. On a pointer it
// floats over the bottom-left corner. Both are the same markup; globals.css
// decides which.
function JobCard({
  placed,
  now,
  onClose,
}: {
  placed: Placed;
  now: number;
  onClose: () => void;
}) {
  const { entry, precision, place } = placed;
  const { inc, units } = entry;
  const { street, locality } = splitAddress(inc.location);
  const card = useRef<HTMLDivElement>(null);

  // Deliberately not components/use-dialog.ts, which traps focus: this card is
  // not modal. The map behind it stays live — panning it, or opening another
  // marker, is the normal way to use the two together — so all it takes is the
  // focus (for a keyboard) and Escape (for everyone).
  useEffect(() => {
    card.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      ref={card}
      role="dialog"
      aria-label={`Incident ${inc.incidentNo || "details"}`}
      tabIndex={-1}
      className="map-card"
    >
      <div className="map-card-head">
        <div className="map-card-title">
          {inc.type ? (
            <span className={`type-tag ${typeClass(inc.type)}`}>{inc.type.toUpperCase()}</span>
          ) : (
            <span className="type-tag default">INCIDENT</span>
          )}
          <span className="map-card-inc">{inc.incidentNo}</span>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="map-card-body">
        <div className="map-card-when">
          <span className="time-cell">{fmt(inc.receivedAt)}</span>
          <span className="dim">· paged {relativeAge(inc.receivedAt, now)} ago</span>
        </div>

        <div className="map-card-where">
          {precision === "exact" ? (
            <>
              <span className="street">{street || inc.location}</span>
              {locality && <span className="locality">{locality}</span>}
            </>
          ) : (
            <>
              <span className="street">{place}</span>
              <span className="locality">
                {precision === "station"
                  ? "Approximate — this page carried no address, so it sits on the responding station's suburb."
                  : "Approximate — looked up from the address text, which carried no coordinates."}
              </span>
            </>
          )}
        </div>

        {units.length > 0 && (
          <div className="cs-cell">
            {units.map((u) => (
              <span key={u.name} className={`badge${u.stopped ? " stopped" : ""}`}>
                {u.name}
              </span>
            ))}
          </div>
        )}

        <div className="map-card-actions">
          <a
            className="map-link"
            href={googleMapsHref(placed.coords)}
            onClick={(e) => openInMaps(e, placed.coords)}
            target="_blank"
            rel="noopener noreferrer"
          >
            ↗ Maps
          </a>
          {inc.incidentNo && (
            <Link className="map-link" href={`/?incident=${encodeURIComponent(inc.incidentNo)}`}>
              Full details
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// ── the map ─────────────────────────────────────────────────────────────────

type Toast = { key: string; label: string; place: string; at: number };

export default function LiveMap({ getToken }: { getToken: () => string | null }) {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [hours, setHours] = useState<number>(DEFAULT_WINDOW);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState<LiveState>("connecting");
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [heat, setHeat] = useState(true);
  const [sound, setSound] = useState(false);
  const [basemap, setBasemap] = useState<BaseMap>("dark");
  const [legendOpen, setLegendOpen] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  // Lookups that have come back, keyed by the query that was asked. Shared
  // across jobs: a suburb is looked up once however many jobs sit in it.
  const [geo, setGeo] = useState<Map<string, Coords>>(() => new Map());
  // Jobs that arrived while this map has been open, and when. Drives the pulse
  // ring and nothing else — the toast keeps its own list so it can be dismissed.
  const [freshKeys, setFreshKeys] = useState<Map<string, number>>(() => new Map());

  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const layersReady = useRef(false);
  const dataRef = useRef<{ type: "FeatureCollection"; features: JobFeature[] }>({
    type: "FeatureCollection",
    features: [],
  });
  const loadSequence = useRef(0);
  const seenRef = useRef<Set<string> | null>(null);
  const fittedRef = useRef(false);
  const soundRef = useRef(false);
  // `getToken` is a fresh closure on every render of the gate above us, and the
  // window is read inside a subscription that must only ever be built once —
  // both are reached through a ref rather than through a dependency list.
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const hoursRef = useRef(DEFAULT_WINDOW);
  const chimeRef = useRef<(() => void) | null>(null);
  const selectedRef = useRef<string | null>(null);
  const placedRef = useRef<Map<string, Placed>>(new Map());
  const heatRef = useRef(true);
  // The style the map is actually showing. A basemap switch is asked for by
  // state and answered by the map, and the two are only in step once the new
  // style has loaded — so what has been applied is tracked rather than inferred.
  const appliedStyle = useRef<BaseMap>("dark");

  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => { heatRef.current = heat; }, [heat]);
  useEffect(() => { hoursRef.current = hours; }, [hours]);
  useEffect(() => { selectedRef.current = selectedKey; }, [selectedKey]);

  // Restore what this device chose last time. In an effect rather than in the
  // useState initialiser so the server and the first client render agree.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(STORE.window));
      if (WINDOWS.includes(saved as (typeof WINDOWS)[number])) setHours(saved);
      const style = localStorage.getItem(STORE.basemap);
      if (style === "dark" || style === "satellite") setBasemap(style);
    } catch {
      // Unavailable storage — the defaults are good ones.
    }
    setHeat(readFlag(STORE.heat, true));
    setSound(readFlag(STORE.sound, false));
  }, []);

  // ── data ──────────────────────────────────────────────────────────────────

  const fetchPage = useCallback(async (before?: Incident): Promise<Incident[] | null> => {
    try {
      const auth = tokenRef.current();
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) {
        params.set("before", before.receivedAt);
        params.set("beforeId", before.id);
      }
      const res = await fetch(`/api/incidents?${params}`, {
        cache: "no-store",
        headers: auth ? { Authorization: `Bearer ${auth}` } : {},
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data.incidents) ? data.incidents : null;
    } catch {
      return null;
    }
  }, []);

  // Pull enough pages to cover the window, newest first, stopping as soon as a
  // page reaches past the cutoff. A quiet four hours is one request; picking 24
  // hours on a busy day is a handful.
  const load = useCallback(async (windowHours: number) => {
    const sequence = ++loadSequence.current;
    const cutoff = Date.now() - windowHours * 3_600_000;
    let all: Incident[] = [];
    let before: Incident | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await fetchPage(before);
      if (sequence !== loadSequence.current) return;
      if (!rows) {
        if (all.length === 0) {
          setLoading(false);
          setFeedError("Couldn't load incidents. Check your connection and try again.");
          return;
        }
        break;
      }
      all = mergeById(all, rows);
      const oldest = all[all.length - 1];
      if (rows.length < PAGE_SIZE || !oldest || new Date(oldest.receivedAt).getTime() < cutoff) break;
      before = oldest;
    }

    if (sequence !== loadSequence.current) return;
    setFeedError("");
    setLoading(false);
    // Folded into what's held rather than replacing it: a Realtime row that
    // landed while this was in flight is newer than anything the fetch saw.
    setIncidents((prev) => mergeById(prev, all));
  }, [fetchPage]);

  useEffect(() => { void load(hours); }, [hours, load]);

  // Live rows, the heartbeat behind them, and a fresh read on every return to
  // the foreground — the same trio the board runs on (components/PagerBoard.tsx),
  // for the same reasons.
  useEffect(() => {
    const channel = getBrowserClient()
      .channel("incidents-map")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "incidents" },
        (payload) => {
          const row = payload.eventType === "DELETE" ? null : payload.new;
          if (row && typeof row.id === "string") {
            setIncidents((prev) => mergeById(prev, [toIncident(row)]));
          } else {
            // A DELETE payload carries only the key, so a wipe is re-read.
            void load(hoursRef.current);
          }
        },
      )
      .subscribe();

    const readState = () => {
      const s = channel.state;
      setLive(s === "joined" ? "live" : s === "joining" ? "connecting" : "down");
    };
    const stateTimer = setInterval(readState, 2_000);
    const heartbeat = setInterval(() => void load(hoursRef.current), 30_000);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setNow(Date.now());
      void load(hoursRef.current);
      if (channel.state !== "joined") channel.subscribe();
      readState();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);

    return () => {
      getBrowserClient().removeChannel(channel);
      clearInterval(stateTimer);
      clearInterval(heartbeat);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [load]);

  // Jobs that *started* inside the window. Merged first and filtered after, so a
  // job keeps the fullest copy of its address and its real start time rather
  // than whichever of its rows happened to fall inside the cutoff.
  const entries = useMemo(() => {
    const cutoff = now - hours * 3_600_000;
    return mergeEntries(incidents.filter(hasIncidentNumber))
      .filter((e) => new Date(e.inc.receivedAt).getTime() >= cutoff)
      .sort((a, b) =>
        a.inc.receivedAt < b.inc.receivedAt ? 1 : a.inc.receivedAt > b.inc.receivedAt ? -1 : 0,
      );
  }, [incidents, hours, now]);

  // Every job that can be put somewhere, with how well we know where. Reads the
  // geocode cache synchronously, so a suburb resolved on an earlier visit is on
  // the map in the first paint rather than a request later.
  const placed = useMemo(() => {
    const out: Placed[] = [];
    for (const entry of entries) {
      const where = placeJob({
        coords: entry.inc.coords,
        location: entry.inc.location,
        units: entry.units.map((u) => u.name),
        raw: entry.inc.raw,
      });
      if (where.precision === "exact") {
        out.push({ entry, coords: where.coords, precision: "exact", place: entry.inc.location });
        continue;
      }
      if (where.precision === "none") continue;
      const found = geo.get(where.query) ?? cachedGeocode(where.query);
      if (found) out.push({ entry, coords: found, precision: where.precision, place: where.label });
    }
    return out;
  }, [entries, geo]);

  useEffect(() => {
    placedRef.current = new Map(placed.map((p) => [p.entry.key, p]));
  }, [placed]);

  // Look up the places we don't have yet. Four at a time: enough that a busy
  // window fills in quickly, few enough that opening the map fires fifty
  // requests at once.
  //
  // Nothing is remembered here about what has been asked, and no request is
  // cancelled when this re-runs. lib/geocode.ts already returns the same promise
  // to everyone waiting on a query and answers a known miss without a request,
  // so a repeat pass costs nothing — while a component-level "already asked"
  // set would turn one dropped connection into a job that never gets a pin.
  useEffect(() => {
    if (!token) return;
    const pending = new Map<string, string>();
    for (const entry of entries) {
      const where = placeJob({
        coords: entry.inc.coords,
        location: entry.inc.location,
        units: entry.units.map((u) => u.name),
        raw: entry.inc.raw,
      });
      if (where.precision === "exact" || where.precision === "none") continue;
      if (cachedGeocode(where.query)) continue;
      pending.set(where.query, where.types);
    }
    if (pending.size === 0) return;

    let alive = true;
    (async () => {
      const queue = [...pending.entries()];
      while (queue.length > 0 && alive) {
        const batch = queue.splice(0, 4);
        const found = await Promise.all(
          batch.map(async ([query, types]) => {
            const coords = await forwardGeocode(query, token, { types });
            return [query, coords] as const;
          }),
        );
        if (!alive) return;
        const hits = found.filter((f): f is readonly [string, Coords] => f[1] !== null);
        if (hits.length === 0) continue;
        setGeo((held) => {
          const next = new Map(held);
          for (const [query, coords] of hits) next.set(query, coords);
          return next;
        });
      }
    })();

    return () => { alive = false; };
  }, [entries, token]);

  // ── new jobs ──────────────────────────────────────────────────────────────
  //
  // Every job on the map is compared against the pass before. One we've never
  // held, and that was paged in the last ten minutes, is news: it rings, it
  // pulses, and it says so at the top of the screen. The ten minutes is what
  // separates a job being paged from an older one arriving because the window
  // was widened or a slow source caught up.
  useEffect(() => {
    const keys = new Set(entries.map((e) => e.key));
    const before = seenRef.current;
    seenRef.current = keys;
    if (!before) return; // first pass: the whole window would ring at once

    const cutoff = Date.now() - NEW_JOB_MAX_AGE_MS;
    const arrived = entries.filter(
      (e) => !before.has(e.key) && new Date(e.inc.receivedAt).getTime() >= cutoff,
    );
    if (arrived.length === 0) return;

    const at = Date.now();
    setFreshKeys((held) => {
      const next = new Map(held);
      for (const e of arrived) next.set(e.key, at);
      return next;
    });
    setToasts((held) =>
      [
        ...arrived.map((e) => ({
          key: e.key,
          label: e.inc.type ? e.inc.type.toUpperCase() : `INCIDENT ${e.inc.incidentNo}`,
          place: e.inc.location
            ? splitAddress(e.inc.location).locality || e.inc.location
            : e.units[0]?.name ?? "",
          at,
        })),
        ...held,
      ].slice(0, 4),
    );
    if (soundRef.current) chimeRef.current?.();
  }, [entries]);

  // Retire the pulse and the toasts on their own clocks.
  useEffect(() => {
    if (freshKeys.size === 0 && toasts.length === 0) return;
    const t = setInterval(() => {
      const at = Date.now();
      setFreshKeys((held) => {
        const next = new Map([...held].filter(([, when]) => at - when < PULSE_MS));
        return next.size === held.size ? held : next;
      });
      setToasts((held) => {
        const next = held.filter((toast) => at - toast.at < TOAST_MS);
        return next.length === held.length ? held : next;
      });
    }, 1_000);
    return () => clearInterval(t);
  }, [freshKeys, toasts]);

  // ── the map itself ────────────────────────────────────────────────────────

  // Everything the style owns. Re-run verbatim after a basemap switch, which
  // throws the old style's sources and layers away with it.
  const installLayers = useCallback((map: mapboxgl.Map) => {
    const data = dataRef.current;

    if (!map.getSource(SRC.plain)) {
      map.addSource(SRC.plain, { type: "geojson", data });
    }
    if (!map.getSource(SRC.clustered)) {
      map.addSource(SRC.clustered, {
        type: "geojson",
        data,
        cluster: true,
        // Stops clustering once the streets are readable — past this zoom you're
        // looking at one town and want its jobs separately.
        clusterMaxZoom: 11,
        clusterRadius: 46,
      });
    }

    if (!map.getLayer(LYR.heat)) {
      map.addLayer({
        id: LYR.heat,
        type: "heatmap",
        source: SRC.plain,
        maxzoom: 13,
        paint: {
          "heatmap-weight": ["get", "weight"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 4, 1, 13, 3],
          // Cool where it's quiet, hot where the traffic stacks up. Starts fully
          // transparent so an empty part of the state stays the basemap.
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.2, "rgba(37,99,235,0.45)",
            0.4, "rgba(34,211,238,0.55)",
            0.6, "rgba(250,204,21,0.70)",
            0.8, "rgba(249,115,22,0.82)",
            1, "rgba(239,68,68,0.92)",
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 16, 9, 34, 13, 58],
          // Hands over to the markers as they become individually readable.
          "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0.9, 13, 0],
        },
      });
    }

    // The "somewhere in this suburb" halo, under everything else.
    if (!map.getLayer(LYR.approx)) {
      map.addLayer({
        id: LYR.approx,
        type: "circle",
        source: SRC.clustered,
        filter: ["all", ["!", ["has", "point_count"]], ["!=", ["get", "precision"], "exact"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 10, 12, 26, 15, 54],
          "circle-color": ["get", "color"],
          "circle-opacity": 0.13,
          "circle-stroke-width": 1,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": 0.35,
        },
      });
    }

    if (!map.getLayer(LYR.pulse)) {
      map.addLayer({
        id: LYR.pulse,
        type: "circle",
        source: SRC.plain,
        filter: ["==", ["get", "fresh"], true],
        paint: {
          "circle-radius": 10,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2,
          "circle-stroke-color": ["get", "color"],
          "circle-stroke-opacity": 0.8,
        },
      });
    }

    if (!map.getLayer(LYR.clusters)) {
      map.addLayer({
        id: LYR.clusters,
        type: "circle",
        source: SRC.clustered,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": [
            "step", ["get", "point_count"],
            "rgba(56,189,248,0.85)", 5,
            "rgba(250,204,21,0.85)", 15,
            "rgba(239,68,68,0.88)",
          ],
          "circle-radius": ["step", ["get", "point_count"], 15, 5, 20, 15, 27],
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(10,10,10,0.75)",
        },
      });
      map.addLayer({
        id: LYR.clusterCount,
        type: "symbol",
        source: SRC.clustered,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#0a0a0a" },
      });
    }

    if (!map.getLayer(LYR.selected)) {
      map.addLayer({
        id: LYR.selected,
        type: "circle",
        source: SRC.plain,
        filter: ["==", ["get", "key"], ""],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 12, 14, 20],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": 0.9,
        },
      });
    }

    if (!map.getLayer(LYR.point)) {
      map.addLayer({
        id: LYR.point,
        type: "circle",
        source: SRC.clustered,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 5, 10, 8, 14, 11],
          "circle-color": ["get", "color"],
          // A dot that came off the page gets a hard white edge; one we placed
          // from text gets a soft one, so the difference is visible without
          // opening anything.
          "circle-stroke-width": 2,
          "circle-stroke-color": [
            "case", ["==", ["get", "precision"], "exact"], "#ffffff", "rgba(255,255,255,0.45)",
          ],
          "circle-opacity": ["case", ["==", ["get", "precision"], "exact"], 1, 0.8],
        },
      });
      map.addLayer({
        id: LYR.label,
        type: "symbol",
        source: SRC.clustered,
        filter: ["!", ["has", "point_count"]],
        // Only once the map is down to a town — at state zoom this is a wall of
        // overlapping words.
        minzoom: 10.5,
        layout: {
          "text-field": ["get", "label"],
          "text-size": 10.5,
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-max-width": 12,
          "text-optional": true,
        },
        paint: {
          "text-color": "#e5e7eb",
          "text-halo-color": "rgba(0,0,0,0.85)",
          "text-halo-width": 1.4,
        },
      });
    }

    layersReady.current = true;
    // A style reload arrives with the layers at their defaults, so everything
    // the user had set is re-stated here rather than waiting on a state change
    // that isn't coming.
    map.setLayoutProperty(LYR.heat, "visibility", heatRef.current ? "visible" : "none");
    map.setFilter(LYR.selected, ["==", ["get", "key"], selectedRef.current ?? " "]);
    for (const id of [SRC.plain, SRC.clustered]) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(dataRef.current);
    }
  }, []);

  // Build the map once. Style changes and data updates are applied to it in
  // their own effects below rather than by rebuilding.
  useEffect(() => {
    if (!token || !container.current || mapRef.current) return;
    mapboxgl.accessToken = token;

    let map: mapboxgl.Map;
    try {
      map = new mapboxgl.Map({
        container: container.current,
        style: STYLES.dark,
        center: HOME.center,
        zoom: HOME.zoom,
        attributionControl: true,
        // The board is read at a glance and often one-handed; a map that has
        // rotated itself off north is one more thing to undo.
        pitchWithRotate: false,
        dragRotate: false,
      });
    } catch {
      setMapFailed(true);
      return;
    }

    mapRef.current = map;
    map.on("error", () => setMapFailed(true));
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "bottom-right");
    map.on("load", () => {
      setMapFailed(false);
      // The container is sized by CSS that may settle after the map was built
      // (the topbar publishes its own height, and a phone rotates); measuring
      // again here is cheap and a mis-sized canvas is invisible until it isn't.
      map.resize();
      installLayers(map);
    });
    // A basemap switch throws the style away and everything in it; put it back.
    map.on("style.load", () => {
      layersReady.current = false;
      installLayers(map);
    });

    map.on("click", LYR.point, (e) => {
      const key = clicked(e.features?.[0])?.properties?.key;
      if (typeof key === "string") setSelectedKey(key);
    });
    map.on("click", LYR.clusters, (e) => {
      const feature = clicked(e.features?.[0]);
      const clusterId = feature?.properties?.cluster_id;
      const source = map.getSource(SRC.clustered) as GeoJSONSource | undefined;
      const centre = feature?.geometry?.coordinates;
      if (!source || typeof clusterId !== "number" || !centre) return;
      source.getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err || zoom == null) {
          // Fall back to stepping in — the cluster still opens, just less neatly.
          map.easeTo({ center: centre, zoom: map.getZoom() + 2 });
          return;
        }
        map.easeTo({ center: centre, zoom });
      });
    });
    // Tapping the map away from a marker closes the card, the way tapping the
    // backdrop of a dialog does.
    map.on("click", (e) => {
      const hits = map.queryRenderedFeatures(e.point, {
        layers: [LYR.point, LYR.clusters].filter((id) => map.getLayer(id)),
      });
      if (hits.length === 0) setSelectedKey(null);
    });
    for (const id of [LYR.point, LYR.clusters]) {
      map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
    }

    return () => {
      map.remove();
      mapRef.current = null;
      layersReady.current = false;
    };
  }, [token, installLayers]);

  // Feed the sources. Cheap enough to run on every change: setData is a diff on
  // the worker's side, and the whole window is a few hundred points.
  useEffect(() => {
    const features = placed.map((p) =>
      featureFor(p, now, hours * 3_600_000, freshKeys.has(p.entry.key)),
    );
    dataRef.current = { type: "FeatureCollection", features };
    const map = mapRef.current;
    if (!map || !layersReady.current) return;
    for (const id of [SRC.plain, SRC.clustered]) {
      (map.getSource(id) as GeoJSONSource | undefined)?.setData(dataRef.current);
    }
  }, [placed, now, hours, freshKeys]);

  // Frame the traffic the first time there is any. Only once: a map that
  // re-framed itself every time a page arrived would move under the hand of
  // someone reading it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current || placed.length === 0) return;
    fittedRef.current = true;
    const bounds = new mapboxgl.LngLatBounds();
    for (const p of placed) bounds.extend([p.coords.lng, p.coords.lat]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 11, duration: 900 });
  }, [placed]);

  // The pulse on a job that has just been paged: a ring that grows out of the
  // marker and fades, once a second, for two minutes. Driven by paint properties
  // rather than a DOM marker so it survives clustering and costs one layer.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || freshKeys.size === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const step = () => {
      const phase = (performance.now() % 1600) / 1600;
      if (map.getLayer(LYR.pulse)) {
        map.setPaintProperty(LYR.pulse, "circle-radius", 8 + phase * 30);
        map.setPaintProperty(LYR.pulse, "circle-stroke-opacity", 0.85 * (1 - phase));
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [freshKeys]);

  // Heat on/off, and which job is ringed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(LYR.heat)) return;
    map.setLayoutProperty(LYR.heat, "visibility", heat ? "visible" : "none");
  }, [heat]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(LYR.selected)) return;
    // "" is a key nothing can have — the filter's "select none".
    map.setFilter(LYR.selected, ["==", ["get", "key"], selectedKey ?? ""]);
  }, [selectedKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedStyle.current === basemap) return;
    appliedStyle.current = basemap;
    try {
      map.setStyle(STYLES[basemap]);
    } catch {
      setMapFailed(true);
    }
  }, [basemap]);

  const selected = useMemo(
    () => (selectedKey ? placed.find((p) => p.entry.key === selectedKey) ?? null : null),
    [placed, selectedKey],
  );

  // Opening a job from a toast (or from a card that's already open) brings the
  // map to it rather than leaving you to find the ring.
  const focusJob = useCallback((key: string) => {
    setSelectedKey(key);
    const map = mapRef.current;
    const target = placedRef.current.get(key);
    if (!map || !target) return;
    const point = target.precision === "exact" ? target.coords : scatter(key, target.coords);
    map.easeTo({
      center: [point.lng, point.lat],
      zoom: Math.max(map.getZoom(), 12),
      duration: 800,
    });
  }, []);

  const fitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = placedRef.current;
    if (points.size === 0) {
      map.easeTo({ center: HOME.center, zoom: HOME.zoom, duration: 600 });
      return;
    }
    const bounds = new mapboxgl.LngLatBounds();
    for (const p of points.values()) bounds.extend([p.coords.lng, p.coords.lat]);
    map.fitBounds(bounds, { padding: 80, maxZoom: 11, duration: 700 });
  }, []);

  function toggleSound() {
    const next = !sound;
    setSound(next);
    writeSetting(STORE.sound, next ? "1" : "0");
    if (next) {
      // This click is the gesture that lets a browser make a noise later, so the
      // chime is built (and demonstrated) right here.
      chimeRef.current ??= makeChime();
      chimeRef.current();
    }
  }

  function chooseWindow(next: number) {
    setHours(next);
    writeSetting(STORE.window, String(next));
    // A wider window is a different question, so let it re-frame the answer.
    fittedRef.current = false;
  }

  // The alert-preferences picker offers the areas the loaded traffic mentions,
  // exactly as the board builds them.
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

  const approximate = placed.filter((p) => p.precision !== "exact").length;
  const unplaced = entries.length - placed.length;

  return (
    <div className="app map-app">
      <header className="topbar">
        <div className="brand">
          <Image src={logo} alt="BelterHub" sizes="160px" />
        </div>

        <div className="topbar-spacer" />

        <Link className="back-btn" href="/" title="Back to the incident board">
          ← Board
        </Link>

        <EnableAlerts lgaOptions={lgaOptions} />

        <LiveDot state={live} />
        <Clock />
      </header>

      {feedError && (
        <div className="feed-error" role="alert">
          {feedError}{" "}
          <button className="chip" onClick={() => void load(hours)}>Retry</button>
        </div>
      )}

      <div className="map-stage">
        {/* The canvas stays mounted even once Mapbox has reported a problem —
            the map instance holds this element, and pulling it out from under a
            live instance is its own crash. The notice covers it instead. */}
        {token && <div ref={container} className="map-canvas" aria-label="Map of recent incidents" />}
        {(!token || mapFailed) && (
          <div className="map-unavailable" role="status">
            <p>The map is unavailable.</p>
            <p className="dim">
              {token
                ? "Mapbox couldn't load. The board has everything the map does."
                : "No Mapbox token is configured for this deployment."}
            </p>
            <Link className="map-link" href="/">Back to the board</Link>
          </div>
        )}

        {/* Everything below floats over the map, so none of it exists without
            one. */}
        {token && !mapFailed && (
          <>
          {/* Window picker — the one control that changes what the map is *of*,
              so it sits alone at the top rather than in the tool stack. */}
          <div className="map-hud" role="group" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={`map-chip${hours === w ? " on" : ""}`}
                aria-pressed={hours === w}
                onClick={() => chooseWindow(w)}
              >
                {w}h
              </button>
            ))}
            <span className="map-count" aria-live="polite">
              {loading && placed.length === 0
                ? "Loading…"
                : `${entries.length} ${entries.length === 1 ? "job" : "jobs"}`}
            </span>
          </div>

          <div className="map-tools">
            <button
              type="button"
              className={`map-tool${heat ? " on" : ""}`}
              aria-pressed={heat}
              title="Heat map — where the traffic is concentrated"
              onClick={() => { setHeat(!heat); writeSetting(STORE.heat, heat ? "0" : "1"); }}
            >
              Heat
            </button>
            <button
              type="button"
              className={`map-tool${basemap === "satellite" ? " on" : ""}`}
              aria-pressed={basemap === "satellite"}
              title="Satellite imagery"
              onClick={() => {
                const next: BaseMap = basemap === "dark" ? "satellite" : "dark";
                setBasemap(next);
                writeSetting(STORE.basemap, next);
              }}
            >
              Sat
            </button>
            <button type="button" className="map-tool" title="Frame everything on the map" onClick={fitAll}>
              Fit
            </button>
            <button
              type="button"
              className={`map-tool${sound ? " on" : ""}`}
              aria-pressed={sound}
              title={sound ? "Chime on a new job — on" : "Chime on a new job — off"}
              onClick={toggleSound}
            >
              {sound ? "♪ On" : "♪ Off"}
            </button>
          </div>

          {/* New jobs announce themselves here. Tapping one takes the map to it. */}
          {toasts.length > 0 && (
            <div className="map-toasts" role="status" aria-live="polite">
              {toasts.map((toast) => (
                <button
                  key={`${toast.key}-${toast.at}`}
                  type="button"
                  className="map-toast"
                  onClick={() => focusJob(toast.key)}
                >
                  <span className="map-toast-tag">NEW</span>
                  <span className="map-toast-text">
                    {toast.label}
                    {toast.place && <span className="dim"> · {toast.place}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className={`map-legend${legendOpen ? " open" : ""}`}>
            <button
              type="button"
              className="map-legend-toggle"
              aria-expanded={legendOpen}
              onClick={() => setLegendOpen(!legendOpen)}
            >
              Key
            </button>
            <div className="map-legend-body">
              {LEGEND.map((item) => (
                <span key={item.cls} className="map-legend-row">
                  <span className="map-legend-dot" style={{ background: TYPE_COLOR[item.cls] }} />
                  {item.label}
                </span>
              ))}
              <span className="map-legend-row">
                <span className="map-legend-dot approx" />
                Approximate ({approximate})
              </span>
              {unplaced > 0 && (
                <span className="map-legend-note">
                  {unplaced} {unplaced === 1 ? "job isn't" : "jobs aren't"} on the map — the page
                  said nothing about where, or the lookup found nothing.
                </span>
              )}
            </div>
          </div>

          {selected && (
            <JobCard placed={selected} now={now} onClose={() => setSelectedKey(null)} />
          )}
        </>
        )}
      </div>
    </div>
  );
}
