"use client";

// Browser-side helpers for web push: enabling device notifications and following
// individual incidents for unit-added updates. Shared by EnableAlerts (the
// topbar toggle) and the incident modal's "Follow updates" button so the
// subscribe flow lives in one place.

import { DEFAULT_PREFS, type AlertPrefs } from "./alert-prefs";

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

// A stable id for this device, so the server can recognise a re-subscribe as the
// same phone rather than a second one. Derived from the durable invite token the
// access gate already stores (components/AccessGate.tsx), hashed so the push
// table never holds the credential itself. Empty when the device isn't enrolled
// or crypto.subtle is unavailable — the server just skips the reconcile.
const DEVICE_TOKEN_KEY = "belterhub.invite";

async function deviceKey(): Promise<string> {
  let token: string | null = null;
  try {
    token = localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return ""; // storage blocked (private mode, iframe)
  }
  if (!token || !globalThis.crypto?.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    body: JSON.stringify({ ...sub.toJSON(), deviceKey: await deviceKey() }),
  });
  return res.ok ? sub.endpoint : null;
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
 * This device's area preferences. Returns the defaults ("everything", never
 * chosen) when the device isn't subscribed or the request fails, so the modal
 * always has something sane to render.
 */
export async function getAlertStatus(): Promise<AlertStatus> {
  const endpoint = await currentEndpoint();
  if (!endpoint) return { prefs: DEFAULT_PREFS, chosen: false };
  const res = await fetch(`/api/push/prefs?endpoint=${encodeURIComponent(endpoint)}`);
  if (!res.ok) return { prefs: DEFAULT_PREFS, chosen: false };
  const data = await res.json();
  return { prefs: data.prefs ?? DEFAULT_PREFS, chosen: !!data.chosen };
}

/**
 * Save this device's area preferences. Subscribes first if needed, so the user
 * can pick their areas and be enrolled in one go. Returns true on success.
 */
export async function saveAlertPrefs(prefs: AlertPrefs): Promise<boolean> {
  const endpoint = await ensureSubscribed();
  if (!endpoint) return false;
  const res = await fetch("/api/push/prefs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, ...prefs }),
  });
  return res.ok;
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
