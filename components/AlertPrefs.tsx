"use client";

import { useEffect, useMemo, useState } from "react";
import { getAlertPrefs, saveAlertPrefs } from "@/lib/push-client";
import { DEFAULT_PREFS, type AlertPrefs } from "@/lib/alert-prefs";
import { lgaKey } from "@/lib/lga";
import { KNOWN_LGAS } from "@/lib/nsw-lgas";
import { allFrnswStations, frnswStationName, turnoutKey } from "@/lib/frnsw-stations";

// Picks which incidents this phone gets buzzed for.
//
// Two lists, because the agencies page differently and neither can stand in for
// the other: RFS pages carry an address (so we match its LGA), FRNSW pages carry
// only a turnout number. Both are optional and they're OR'd together.
//
// The LGA options are the ones actually seen on the board — passed in by
// PagerBoard from the incidents it has loaded, so the spelling always matches
// what arrives over the air. Anything not in that list can still be typed.

export interface LgaOption {
  name: string;
  count: number;
}

const STATIONS = allFrnswStations();

export default function AlertPrefsModal({
  lgaOptions,
  onClose,
}: {
  lgaOptions: LgaOption[];
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState<AlertPrefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [lgaQuery, setLgaQuery] = useState("");
  const [stationQuery, setStationQuery] = useState("");

  useEffect(() => {
    getAlertPrefs()
      .then(setPrefs)
      .finally(() => setLoaded(true));
  }, []);

  // Close on Escape, like the incident modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Selected LGAs are compared on the normalised key so a name typed by hand
  // ("Queanbeyan-Palerang Regional") matches the same area picked from the list.
  const selectedLgaKeys = useMemo(
    () => new Set(prefs.lgas.map(lgaKey)),
    [prefs.lgas],
  );

  function toggleLga(name: string) {
    const key = lgaKey(name);
    if (!key) return;
    setPrefs((p) =>
      selectedLgaKeys.has(key)
        ? { ...p, lgas: p.lgas.filter((l) => lgaKey(l) !== key) }
        : { ...p, lgas: [...p.lgas, name.toUpperCase()] },
    );
  }

  function addStation(num: string) {
    const key = turnoutKey(num.trim());
    if (!/^\d{1,4}$/.test(key)) return;
    setPrefs((p) =>
      p.stations.some((s) => turnoutKey(s) === key)
        ? p
        : { ...p, stations: [...p.stations, key] },
    );
    setStationQuery("");
  }

  function removeStation(num: string) {
    setPrefs((p) => ({ ...p, stations: p.stations.filter((s) => s !== num) }));
  }

  async function save() {
    setSaving(true);
    setError("");
    const ok = await saveAlertPrefs(prefs);
    setSaving(false);
    if (ok) onClose();
    else setError("Couldn't save — check notifications are enabled for this device.");
  }

  // Every area we can offer: the ones on the loaded board (which carry a live
  // count) merged over every area the feed has ever paged. Without the seed the
  // picker would only ever show wherever happens to be busy right now.
  const allLgas = useMemo(() => {
    const byKey = new Map<string, { name: string; count: number }>();
    for (const s of KNOWN_LGAS) byKey.set(lgaKey(s.name), { name: s.name, count: 0 });
    for (const o of lgaOptions) {
      const k = lgaKey(o.name);
      // The board's spelling wins — it's what's arriving right now.
      byKey.set(k, { name: o.name, count: o.count });
    }
    return [...byKey.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  }, [lgaOptions]);

  // Suggestions, minus what's already picked.
  const lgaMatches = useMemo(() => {
    const q = lgaQuery.trim().toUpperCase();
    return allLgas.filter(
      (o) => !selectedLgaKeys.has(lgaKey(o.name)) && (!q || o.name.includes(q)),
    );
  }, [allLgas, lgaQuery, selectedLgaKeys]);

  // Station search matches on number or name, so "428" and "QUEAN" both work.
  const stationMatches = useMemo(() => {
    const q = stationQuery.trim().toUpperCase();
    if (!q) return [];
    const picked = new Set(prefs.stations.map(turnoutKey));
    return STATIONS.filter(
      (s) => !picked.has(s.number) && (s.number.startsWith(q) || s.name.includes(q)),
    ).slice(0, 8);
  }, [stationQuery, prefs.stations]);

  // A number typed that we don't know — still allowed (stations do get added),
  // but flagged so a typo doesn't silently subscribe to nothing.
  const typedNumber = /^\d{1,4}$/.test(stationQuery.trim()) ? turnoutKey(stationQuery.trim()) : "";
  const typedIsUnknown = !!typedNumber && !frnswStationName(typedNumber);

  const narrowed = !prefs.alertAll;
  const nothingPicked = narrowed && !prefs.lgas.length && !prefs.stations.length;

  return (
    <div className="modal-overlay prefs-overlay" onClick={onClose}>
      <div className="modal prefs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-inc">Alert areas</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {!loaded ? (
          <div className="modal-body"><span className="dim">Loading…</span></div>
        ) : (
          <div className="modal-body">
            {/* everything vs. narrowed */}
            <div className="prefs-scope">
              <label className="prefs-radio">
                <input
                  type="radio"
                  name="scope"
                  checked={prefs.alertAll}
                  onChange={() => setPrefs((p) => ({ ...p, alertAll: true }))}
                />
                <span>
                  <strong>Everything</strong>
                  <span className="prefs-sub">Every incident on the board</span>
                </span>
              </label>
              <label className="prefs-radio">
                <input
                  type="radio"
                  name="scope"
                  checked={narrowed}
                  onChange={() => setPrefs((p) => ({ ...p, alertAll: false }))}
                />
                <span>
                  <strong>Only my areas</strong>
                  <span className="prefs-sub">Pick RFS areas and FRNSW stations below</span>
                </span>
              </label>
            </div>

            <div className={narrowed ? "" : "prefs-disabled"}>
              {/* ── RFS by LGA ─────────────────────────────────────────── */}
              <div className="prefs-section">
                <span className="modal-label">RFS — by area (LGA)</span>

                {prefs.lgas.length > 0 && (
                  <div className="prefs-chips">
                    {prefs.lgas.map((l) => (
                      <button key={l} className="prefs-chip" onClick={() => toggleLga(l)}>
                        {l}<span className="prefs-chip-x">×</span>
                      </button>
                    ))}
                  </div>
                )}

                <input
                  className="prefs-input"
                  value={lgaQuery}
                  onChange={(e) => setLgaQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && lgaQuery.trim()) {
                      toggleLga(lgaQuery.trim());
                      setLgaQuery("");
                    }
                  }}
                  placeholder="Search areas, e.g. WINGECARRIBEE"
                  disabled={!narrowed}
                />

                <div className="prefs-list">
                  {lgaMatches.map((o) => (
                    <button
                      key={o.name}
                      className="prefs-option"
                      onClick={() => toggleLga(o.name)}
                      disabled={!narrowed}
                    >
                      <span>{o.name}</span>
                      {o.count > 0 && <span className="prefs-count">{o.count}</span>}
                    </button>
                  ))}
                  {lgaQuery.trim() && !lgaMatches.length && (
                    <button
                      className="prefs-option"
                      onClick={() => { toggleLga(lgaQuery.trim()); setLgaQuery(""); }}
                      disabled={!narrowed}
                    >
                      <span>Add “{lgaQuery.trim().toUpperCase()}”</span>
                    </button>
                  )}
                </div>
                <span className="prefs-note">
                  Every area this feed has paged. The number is how many loaded
                  incidents are there now. Not listed? Type it and press Enter.
                </span>
              </div>

              {/* ── FRNSW by station number ────────────────────────────── */}
              <div className="prefs-section">
                <span className="modal-label">FRNSW — by station number</span>

                {prefs.stations.length > 0 && (
                  <div className="prefs-chips">
                    {prefs.stations.map((s) => (
                      <button key={s} className="prefs-chip" onClick={() => removeStation(s)}>
                        {s} {frnswStationName(s) ?? "—"}<span className="prefs-chip-x">×</span>
                      </button>
                    ))}
                  </div>
                )}

                <input
                  className="prefs-input"
                  value={stationQuery}
                  onChange={(e) => setStationQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    if (stationMatches.length) addStation(stationMatches[0].number);
                    else if (typedNumber) addStation(typedNumber);
                  }}
                  placeholder="Type a number, e.g. 428 — or a name"
                  inputMode="text"
                  disabled={!narrowed}
                />

                <div className="prefs-list">
                  {stationMatches.map((s) => (
                    <button
                      key={s.number}
                      className="prefs-option"
                      onClick={() => addStation(s.number)}
                      disabled={!narrowed}
                    >
                      <span><span className="prefs-num">{s.number}</span> {s.name}</span>
                    </button>
                  ))}
                  {typedIsUnknown && (
                    <button
                      className="prefs-option"
                      onClick={() => addStation(typedNumber)}
                      disabled={!narrowed}
                    >
                      <span>Add {typedNumber} — not a station we know</span>
                    </button>
                  )}
                </div>
                <span className="prefs-note">
                  FRNSW pages carry no address, only a turnout number — so they’re
                  matched by station, not by area.
                </span>
              </div>
            </div>

            {nothingPicked && (
              <span className="prefs-warn">
                Nothing picked — you won’t get any alerts until you add an area or a station.
              </span>
            )}
            {error && <span className="prefs-warn">{error}</span>}

            <div className="prefs-actions">
              <button className="prefs-cancel" onClick={onClose}>Cancel</button>
              <button className="prefs-save" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
