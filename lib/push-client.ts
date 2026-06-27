"use client";

// Browser-side helpers for web push: enabling device notifications and following
// individual incidents for unit-added updates. Shared by EnableAlerts (the
// topbar toggle) and the incident modal's "Follow updates" button so the
// subscribe flow lives in one place.

// The VAPID public key is safe to ship to the client; the private key stays on
// the feeder. Without it there's nothing to subscribe against.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

// VAPID keys are base64url; the subscribe call needs them as a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when this browser can do web push at all and we have a key to use. */
export function pushSupported(): boolean {
  return (
    !!VAPID_PUBLIC_KEY &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** The current device's push subscription endpoint, or null if not subscribed. */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub?.endpoint ?? null;
}

/**
 * Register the service worker, request permission, subscribe, and persist the
 * subscription. Returns the endpoint on success, or null if push is
 * unsupported, permission was denied, or saving failed. Safe to call repeatedly
 * — it reuses an existing subscription.
 */
export async function ensureSubscribed(): Promise<string | null> {
  if (!pushSupported()) return null;

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  if (Notification.permission === "denied") return null;
  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
  }

  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
    }));

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  return res.ok ? sub.endpoint : null;
}

/** Whether this device is following unit-added updates for the given incident. */
export async function isFollowing(incidentNo: string): Promise<boolean> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return false;
  const qs = new URLSearchParams({ incidentNo, endpoint });
  const res = await fetch(`/api/push/follow?${qs}`);
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.following;
}

/**
 * Follow unit-added updates for an incident. Enables device push first if
 * needed, so a tap straight from the modal works. Returns true on success.
 */
export async function followIncident(incidentNo: string): Promise<boolean> {
  const endpoint = await ensureSubscribed();
  if (!endpoint) return false;
  const res = await fetch("/api/push/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentNo, endpoint }),
  });
  return res.ok;
}

/** Stop following updates for an incident on this device. */
export async function unfollowIncident(incidentNo: string): Promise<boolean> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return true; // nothing subscribed → already not following
  const res = await fetch("/api/push/follow", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentNo, endpoint }),
  });
  return res.ok;
}
