// "Open this in the maps app" — the one link the board and the live map both
// hand out. Kept apart from lib/maps.ts, which builds a *server-side* static
// image URL and reads a private token to do it.

// True on Apple platforms (iPhone/iPad/iPod, plus macOS — modern iPadOS reports
// as "Macintosh"). Guarded for SSR where navigator is undefined.
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
}

// Universal Google Maps link — works everywhere and is the safe SSR / right-click
// default. Apple users get routed to Apple Maps at click time (see openInMaps).
export function googleMapsHref(coords: { lat: number; lng: number }): string {
  return `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
}

// Open the incident in the platform's preferred maps app. Apple platforms open
// Apple Maps; everyone else falls through to the anchor's Google Maps href.
export function openInMaps(
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
