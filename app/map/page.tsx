import AccessGate from "@/components/AccessGate";

export const dynamic = "force-dynamic";

// The live map, gated by the same per-device invite as the board — see the note
// in app/page.tsx for why nothing is prefetched server-side.
export default function MapPage() {
  return <AccessGate view="map" />;
}
