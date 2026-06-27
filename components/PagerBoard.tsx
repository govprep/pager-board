"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Incident } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";
import { hasIncidentNumber } from "@/lib/parser";
import { satelliteMapUrl } from "@/lib/maps";
import EnableAlerts from "@/components/EnableAlerts";
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

type Entry = { inc: Incident; units: string[] };

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
  const { inc, units } = entry;
  const sat = satelliteMapUrl(inc.coords);

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
          <span className="modal-inc">{inc.incidentNo || "Incident"}</span>
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
                href={`https://www.google.com/maps?q=${inc.coords.lat},${inc.coords.lng}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                ↗ open in maps
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

          {inc.coords && (
            <div className="modal-field">
              <span className="modal-label">Satellite</span>
              {sat ? (
                <a
                  href={`https://www.google.com/maps?q=${inc.coords.lat},${inc.coords.lng}&t=k`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="modal-sat-link"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="modal-sat" src={sat} alt="Satellite view of incident location" />
                </a>
              ) : (
                <span className="dim">Set NEXT_PUBLIC_MAPBOX_TOKEN to show a satellite view.</span>
              )}
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

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Refresh from the API (used both by Realtime callbacks and the fallback poll).
  // /api/incidents is members-only, so attach this device's access token.
  async function refresh() {
    try {
      const token = getToken();
      const res = await fetch("/api/incidents", {
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.incidents)) setIncidents(data.incidents);
      }
    } catch { /* keep last board */ }
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

    return () => {
      getBrowserClient().removeChannel(channel);
      clearInterval(t);
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
    const map = new Map<string, { inc: Incident; units: string[] }>();
    for (const i of filtered) {
      const key = i.incidentNo || i.id;
      if (!map.has(key)) map.set(key, { inc: i, units: [] });
      const entry = map.get(key)!;
      for (const u of unitTokens(i.unit)) {
        if (u && !entry.units.includes(u)) entry.units.push(u);
      }
      if (i.receivedAt < entry.inc.receivedAt) entry.inc = { ...entry.inc, receivedAt: i.receivedAt };
    }
    return [...map.values()];
  }, [filtered]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof merged>();
    for (const m of merged) {
      const d = dateKey(m.inc.receivedAt);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(m);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [merged]);

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
                  const { inc: i, units } = entry;
                  const tc = typeClass(i.type);
                  const { street, locality } = splitAddress(i.location);
                  const key = i.incidentNo || i.id;
                  return (
                    <tr key={key} className="data-row">
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
                              href={`https://www.google.com/maps?q=${i.coords.lat},${i.coords.lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              ↗ map
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
