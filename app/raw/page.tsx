import AccessGate from "@/components/AccessGate";

export const dynamic = "force-dynamic";

// The raw pager feed, gated by the same per-device invite as the board — see
// the note in app/page.tsx for why nothing is prefetched server-side.
export default function RawPage() {
  return <AccessGate view="raw" />;
}
