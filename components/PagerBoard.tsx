"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Incident } from "@/lib/types";
import { getBrowserClient } from "@/lib/supabase-browser";

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


function UnitBadges({ unit }: { unit: string }) {
  if (!unit) return <span className="dim">—</span>;
  // Only badge tokens that look like station codes: all-uppercase alphanumeric, 2+ chars.
  const codes = unit.trim().split(/[\s,/]+/).filter(t => /^[A-Z0-9]{2,}$/.test(t));
  const tokens = codes.length > 0 ? codes : [unit.trim().split(/\s+/)[0]];
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

export default function PagerBoard({ initial }: { initial: Incident[] }) {
  const [incidents, setIncidents] = useState<Incident[]>(initial);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Refresh from the API (used both by Realtime callbacks and the fallback poll).
  async function refresh() {
    try {
      const res = await fetch("/api/incidents", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.incidents)) setIncidents(data.incidents);
      }
    } catch { /* keep last board */ }
  }

  useEffect(() => {
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
    let result = incidents.filter((i) => i.type || i.location || i.incidentNo);
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
      const tokens = i.unit.trim().split(/[\s,/]+/).filter(t => /^[A-Z0-9]{2,}$/.test(t));
      const unitTokens = tokens.length > 0 ? tokens : (i.unit.trim() ? [i.unit.trim().split(/\s+/)[0]] : []);
      for (const u of unitTokens) {
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
                {rows.map(({ inc: i, units }) => {
                  const tc = typeClass(i.type);
                  const { street, locality } = splitAddress(i.location);
                  const key = i.incidentNo || i.id;
                  return (
                    <tr key={key} className="data-row">
                      <td>
                        <span className="inc-link">{i.incidentNo || "—"}</span>
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
                          ? <span className={`type-tag ${tc}`}>{i.type}</span>
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

    </div>
  );
}
