"use client";

import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Coords } from "@/lib/types";

// Interactive 3D map for the incident modal. Defaults to the tilted standard
// street map (roads + 3D buildings) and can be flipped to satellite. Pan, zoom,
// rotate and pitch are all live.
//
// Coords come straight from the page when present. When a page arrives without
// them (truncated, or never carried any), we forward-geocode the address text
// so the modal still drops a pin in the right place. Renders nothing useful
// without a public token.

const STYLES = {
  standard: "mapbox://styles/mapbox/standard",
  satellite: "mapbox://styles/mapbox/satellite-streets-v12",
} as const;

type StyleKey = keyof typeof STYLES;

// Zoomed out a touch from the old static view so nearby roads are in frame, with
// a pitch + bearing for the 3D look.
const ZOOM = 15;
const PITCH = 55;
const BEARING = -20;

// Forward-geocode an address to a centre point, biased to Australia. Returns
// null on a miss or any error — the caller shows a fallback message.
async function geocode(address: string, token: string): Promise<Coords | null> {
  try {
    const url =
      `https://api.mapbox.com/search/geocode/v6/forward` +
      `?q=${encodeURIComponent(address)}&country=au&limit=1&access_token=${token}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const c = data?.features?.[0]?.geometry?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    return { lng: c[0], lat: c[1] };
  } catch {
    return null;
  }
}

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
  // Resolved centre: the page coords, or whatever geocoding turned up.
  const [center, setCenter] = useState<Coords | null>(coords ?? null);
  const [status, setStatus] = useState<"ready" | "locating" | "missing">(
    coords ? "ready" : address ? "locating" : "missing",
  );

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // Geocode the address when we have no coords.
  useEffect(() => {
    if (coords || !address || !token) return;
    let alive = true;
    geocode(address, token).then((found) => {
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
    };
  }, [coords, address, token]);

  // Build the map once we have a centre. Rebuilds if the centre lands later
  // (i.e. after geocoding resolves).
  useEffect(() => {
    if (!token || !center || !container.current) return;
    mapboxgl.accessToken = token;

    const m = new mapboxgl.Map({
      container: container.current,
      style: STYLES.standard,
      center: [center.lng, center.lat],
      zoom: ZOOM,
      pitch: PITCH,
      bearing: BEARING,
      attributionControl: false,
    });
    m.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    new mapboxgl.Marker({ color: "#e01b24" }).setLngLat([center.lng, center.lat]).addTo(m);
    setStyle("standard");
    map.current = m;

    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, center]);

  function switchTo(next: StyleKey) {
    if (next === style || !map.current) return;
    map.current.setStyle(STYLES[next]);
    setStyle(next);
  }

  if (!token) {
    return <span className="dim">Set NEXT_PUBLIC_MAPBOX_TOKEN to show the map.</span>;
  }
  if (status === "missing") {
    return <span className="dim">No location to map for this incident.</span>;
  }

  return (
    <div className="incident-map">
      <div ref={container} className="incident-map-canvas" />
      {status === "locating" && (
        <div className="map-locating">Finding address…</div>
      )}
      {center && (
        <div className="map-style-toggle">
          <button
            type="button"
            className={style === "standard" ? "active" : ""}
            onClick={() => switchTo("standard")}
          >
            Map
          </button>
          <button
            type="button"
            className={style === "satellite" ? "active" : ""}
            onClick={() => switchTo("satellite")}
          >
            Satellite
          </button>
        </div>
      )}
    </div>
  );
}
