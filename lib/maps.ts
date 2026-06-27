import type { Coords } from "./types";

// Mapbox Static Images API — renders a map PNG with a single marker at the
// incident coords. The URL is self-contained (token in the query string), so
// Slack can fetch it directly as an image block.
//
// Docs: https://docs.mapbox.com/api/maps/static-images/

const ZOOM = 14;
const SAT_ZOOM = 17; // satellite view sits closer so the property is readable
const SIZE = "600x400@2x"; // @2x = retina; Slack downscales nicely

/**
 * Build a static-map image URL for the given coords, or null when we have no
 * coords or no MAPBOX_TOKEN configured.
 */
export function staticMapUrl(coords: Coords | null): string | null {
  const token = process.env.MAPBOX_TOKEN;
  if (!token || !coords) return null;

  const { lng, lat } = coords;
  // pin-l (large) in red, placed at the incident location.
  const marker = `pin-l+e01b24(${lng},${lat})`;
  const center = `${lng},${lat},${ZOOM},0`;
  return (
    `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/` +
    `${marker}/${center}/${SIZE}?access_token=${token}`
  );
}

/**
 * Same as staticMapUrl but on the satellite-streets style and reading the
 * NEXT_PUBLIC_MAPBOX_TOKEN so it can be used in the browser (e.g. the incident
 * modal). Returns null without coords or a public token.
 */
export function satelliteMapUrl(coords: Coords | null): string | null {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (!token || !coords) return null;

  const { lng, lat } = coords;
  const marker = `pin-l+e01b24(${lng},${lat})`;
  const center = `${lng},${lat},${SAT_ZOOM},0`;
  return (
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/` +
    `${marker}/${center}/${SIZE}?access_token=${token}`
  );
}
