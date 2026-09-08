"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Coords } from "@/lib/types";
import { forwardGeocode } from "@/lib/geocode";

// Interactive 3D map for the incident modal. Defaults to the tilted standard
// street map (roads + 3D buildings) and can be flipped to satellite. Pan, zoom,
// rotate and pitch are all live.
//
// Coords come straight from the page when present. When a page arrives without
// them (truncated, or never carried any), the address text is forward-geocoded
// (lib/geocode.ts, shared with the live map) so the modal still drops a pin in
// the right place. Renders nothing useful without a public token.

const STYLES = {
  // streets-v12 carries a far denser, clearly-labelled road network than the
  // photorealistic "standard" style, which de-emphasises minor streets.
  standard: "mapbox://styles/mapbox/streets-v12",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
} as const;

type StyleKey = keyof typeof STYLES;

// Zoomed out so the surrounding street network is in frame, with a gentle pitch
// + bearing for the 3D look without flattening the road labels.
const ZOOM = 13.5;
const PITCH = 45;
const BEARING = -18;

export default function IncidentMap({
  coords,
  address,
}: {
  coords?: Coords | null;
  address?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [style, setStyle] = useState<StyleKey>("standard");
  const [mapFailed, setMapFailed] = useState(false);
  // Resolved centre: the page coords, or whatever geocoding turned up.
  const [center, setCenter] = useState<Coords | null>(coords ?? null);
  const [status, setStatus] = useState<"ready" | "locating" | "missing">(
    coords ? "ready" : address ? "locating" : "missing",
  );

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // Geocode the address when we have no coords.
  useEffect(() => {
    setMapFailed(false);
    if (coords) { setCenter(coords); setStatus("ready"); return; }
    setCenter(null);
    if (!address || !token) { setStatus("missing"); return; }
    setStatus("locating");
    let alive = true;
    const controller = new AbortController();
    forwardGeocode(address, token, { signal: controller.signal }).then((found) => {
      if (!alive) return;
      if (found) {
        setCenter(found);
        setStatus("ready");
      } else {
        setStatus("missing");
      }
    });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [coords?.lat, coords?.lng, address, token]);

  // Build the map once we have a centre. Rebuilds if the centre lands later
  // (i.e. after geocoding resolves).
  useEffect(() => {
    if (!token || !center || !container.current) return;
    mapboxgl.accessToken = token;

    let m: mapboxgl.Map | undefined;
    try {
    m = new mapboxgl.Map({
      container: container.current,
      style: STYLES.standard,
      center: [center.lng, center.lat],
      zoom: ZOOM,
      pitch: PITCH,
      bearing: BEARING,
      attributionControl: true,
    });
    m.on("error", () => setMapFailed(true));
    m.on("load", () => setMapFailed(false));
    m.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    new mapboxgl.Marker({ color: "#e01b24" }).setLngLat([center.lng, center.lat]).addTo(m);
    setStyle("standard");
    map.current = m;
    } catch {
      m?.remove();
      map.current = null;
      setMapFailed(true);
      return;
    }

    return () => {
      m?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, center]);

  function switchTo(next: StyleKey) {
    if (next === style || !map.current) return;
    try {
      map.current.setStyle(STYLES[next]);
      setStyle(next);
    } catch { setMapFailed(true); }
  }

  if (!token) {
    return <div className="map-fallback" role="status">Map preview is unavailable.</div>;
  }
  if (status === "missing") {
    return <div className="map-fallback" role="status">No location to map for this incident.</div>;
  }

  return (
    <div className="incident-map">
      <div ref={container} className="incident-map-canvas" aria-label="Incident location map" />
      {mapFailed && <div className="map-locating" role="status">Map preview is unavailable. Use the address link to open maps.</div>}
      {status === "locating" && (
        <div className="map-locating" role="status">Finding address…</div>
      )}
      {center && (
        <div className="map-style-toggle">
          <button
            type="button"
            className={style === "standard" ? "active" : ""}
            aria-pressed={style === "standard"}
            onClick={() => switchTo("standard")}
          >
            Map
          </button>
          <button
            type="button"
            className={style === "satellite" ? "active" : ""}
            aria-pressed={style === "satellite"}
            onClick={() => switchTo("satellite")}
          >
            Satellite
          </button>
        </div>
      )}
    </div>
  );
}
