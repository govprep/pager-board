"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Incident } from "@/lib/types";

function minutesAgo(iso: string) {
  return Math.floor((Date.now() - Date.parse(iso)) / 60000);
}

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
  if (/mva|accident|rescue|collision/.test(t)) return "rescue";
  if (/hazmat|chemical|spill|gas/.test(t)) return "hazmat";
  if (/medical|patient|cardiac/.test(t)) return "medical";
  if (/storm|flood|tree|wire/.test(t)) return "storm";
  if (/afa|alarm|auto/.test(t)) return "afa";
  return "default";
}

function statusLetter(iso: string): "I" | "A" | "C" {
  const m = minutesAgo(iso);
  if (m < 30) return "I";
  if (m < 120) return "A";
  return "C";
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

  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch("/api/incidents", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.incidents)) setIncidents(data.incidents);
        }
      } catch { /* keep last board */ }
    }, 5000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return incidents;
    return incidents.filter((i) =>
      `${i.incidentNo} ${i.type} ${i.unit} ${i.location} ${i.raw}`
        .toLowerCase()
        .includes(q)
    );
  }, [incidents, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Incident[]>();
    for (const i of filtered) {
      const d = dateKey(i.receivedAt);
      if (!map.has(d)) map.set(d, []);
      map.get(d)!.push(i);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  return (
    <div className="app">
      {/* header */}
      <header className="topbar">
        <div className="brand">
          <img src="/logo.jpg" alt="Belter Watch" />
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

      {/* count bar */}
      <div className="pagebar">
        {filtered.length === incidents.length
          ? `${incidents.length} incidents`
          : `${filtered.length} of ${incidents.length} incidents`}
      </div>

      {/* table */}
      <div className="list-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 120 }}>Incident</th>
              <th style={{ width: 60 }}>Time</th>
              <th>Address</th>
              <th style={{ width: 160 }}>Type</th>
              <th style={{ width: 52 }}>Repeat</th>
              <th style={{ width: 130 }}>Call Sign</th>
              <th style={{ width: 70 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {grouped.map(([date, rows]) => (
              <Fragment key={date}>
                <tr className="date-row">
                  <td colSpan={7}>{date}</td>
                </tr>
                {rows.map((i) => {
                  const tc = typeClass(i.type);
                  const status = statusLetter(i.receivedAt);
                  const { street, locality } = splitAddress(i.location);
                  return (
                    <tr key={i.id} className="data-row">
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
                      <td className="repeat-cell">0</td>
                      <td>
                        <div className="cs-cell">
                          <UnitBadges unit={i.unit} />
                        </div>
                      </td>
                      <td>
                        <span className={`status-tag ${status}`}>{status}</span>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="empty">
            {search ? `No results for "${search}"` : "No incidents."}
          </div>
        )}
      </div>

      <div className="quitline">
        <div className="quitline-label">Warning</div>
        <div className="quitline-body">
          <p>Think about who you&rsquo;re leaving at home.</p>
          <p>Call the <span>Belter Quitline</span> on <span>1800 BELTER</span></p>
        </div>
      </div>

      <footer className="footer">
        <span>POST to /api/incidents</span>
        <span>polling every 5s</span>
      </footer>
    </div>
  );
}
