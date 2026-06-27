import AccessGate from "@/components/AccessGate";

export const dynamic = "force-dynamic";

// The board is gated behind per-member invite links (AccessGate). We don't
// prefetch incidents server-side — the device's credential lives in
// localStorage, which the server can't see, and prefetching would embed private
// incident data in the HTML for anyone. AccessGate renders the board only once
// the device's invite token exchanges for a valid session; the board then loads
// incidents via the authed /api/incidents fetch.
export default function Page() {
  return <AccessGate />;
}
