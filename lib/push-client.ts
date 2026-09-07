"use client";

// Browser-side helpers for web push: enabling device notifications and following
// individual incidents for unit-added updates. Shared by EnableAlerts (the
// topbar toggle) and the incident modal's "Follow updates" button so the
// subscribe flow lives in one place.

import { DEFAULT_PREFS, type AlertPrefs } from "./alert-prefs";
import { authenticatedFetch } from "./session-client";

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

async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  const data = await response.json().catch(() => null);
  throw new Error(typeof data?.error === "string" ? data.error : "Unable to update alerts. Please retry.");
}

/** True when this browser can do web push at all and we have a key to use. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
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
 * unsupported or permission was denied. Saving failures throw an error. Safe to call repeatedly
 * — it reuses an existing subscription.
 */
let subscribing: Promise<string | null> | null = null;

export function ensureSubscribed(): Promise<string | null> {
  // Mount-time reconciliation and a user's click share the same operation.
  subscribing ??= subscribeDevice().finally(() => { subscribing = null; });
  return subscribing;
}

async function subscribeDevice(): Promise<string | null> {
  if (!pushSupported()) return null;

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  if (Notification.permission === "denied") return null;
  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return null;
  }

  let sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
    }));

  const save = () => authenticatedFetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
  let res = await save();
  if (res.status === 409) {
    // Legacy endpoints without provable ownership cannot be claimed. Rotate
    // the browser's own subscription instead of taking over the existing row.
    if (!await sub.unsubscribe()) throw new Error("Unable to renew alerts. Please retry.");
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!),
    });
    res = await save();
  }
  await requireSuccess(res);
  return sub.endpoint;
}

export interface AlertStatus {
  prefs: AlertPrefs;
  /**
   * Whether this device has ever picked its areas. False means the "everything"
   * it's on is the back-compat default rather than a choice — true of every
   * device enrolled before the picker existed.
   */
  chosen: boolean;
}

/**
 * This device's area preferences. An unsubscribed device starts with defaults;
 * request failures throw so the UI cannot overwrite saved preferences blindly.
 */
export async function getAlertStatus(): Promise<AlertStatus> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return { prefs: DEFAULT_PREFS, chosen: false };
  const res = await authenticatedFetch(`/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`);
  await requireSuccess(res);
  const data = await res.json();
  if (!data.prefs || typeof data.prefs.alertAll !== "boolean" ||
      !Array.isArray(data.prefs.lgas) || !Array.isArray(data.prefs.stations)) {
    throw new Error("Invalid notification settings response. Please retry.");
  }
  return { prefs: data.prefs, chosen: !!data.chosen };
}

/**
 * Save this device's area preferences. Subscribes first if needed, so the user
 * can pick their areas and be enrolled in one go. Returns true on success.
 */
export async function saveAlertPrefs(prefs: AlertPrefs): Promise<boolean> {
  const endpoint = await ensureSubscribed();
  if (!endpoint) return false;
  const res = await authenticatedFetch("/api/push/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, ...prefs }),
  });
  await requireSuccess(res);
  return true;
}

/** Whether this device is following unit-added updates for the given incident. */
export async function isFollowing(incidentNo: string): Promise<boolean> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return false;
  const qs = new URLSearchParams({ incidentNo, endpoint });
  const res = await authenticatedFetch(`/api/push/follow?${qs}`);
  await requireSuccess(res);
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
  const res = await authenticatedFetch("/api/push/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentNo, endpoint }),
  });
  await requireSuccess(res);
  return true;
}

/** Stop following updates for an incident on this device. */
export async function unfollowIncident(incidentNo: string): Promise<boolean> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return true; // nothing subscribed → already not following
  const res = await authenticatedFetch("/api/push/follow", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ incidentNo, endpoint }),
  });
  await requireSuccess(res);
  return true;
}
