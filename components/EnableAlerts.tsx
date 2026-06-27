"use client";

import { useEffect, useState } from "react";

// The VAPID public key is safe to ship to the client; the private key stays on
// the feeder. Without it there's nothing to subscribe against, so we hide the UI.
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

type State =
  | "loading"       // figuring out support/permission
  | "unsupported"   // browser can't do push at all
  | "needs-install" // iOS Safari tab — must Add to Home Screen first
  | "prompt"        // ready, awaiting the user's tap
  | "subscribed"    // good to go
  | "denied"        // user blocked notifications
  | "error";

// VAPID keys are base64url; the subscribe call needs them as a Uint8Array.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// iOS only allows push from an installed (home-screen) PWA, not a Safari tab.
function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Safari-specific flag for home-screen apps.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export default function EnableAlerts() {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    if (!VAPID_PUBLIC_KEY) return setState("unsupported");
    const supported =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    if (!supported) {
      // On iOS, a normal Safari tab lacks PushManager until installed.
      return setState(isIos() && !isStandalone() ? "needs-install" : "unsupported");
    }
    if (isIos() && !isStandalone()) return setState("needs-install");

    if (Notification.permission === "denied") return setState("denied");

    // Already granted? Reflect whether we hold a live subscription.
    navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = reg && (await reg.pushManager.getSubscription());
      setState(sub ? "subscribed" : "prompt");
    });
  }, []);

  async function enable() {
    try {
      setState("loading");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState("denied");

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
      setState(res.ok ? "subscribed" : "error");
    } catch (err) {
      console.error("[push] enable failed:", err);
      setState("error");
    }
  }

  // Nothing useful to offer — stay out of the topbar.
  if (state === "loading" || state === "unsupported") return null;

  if (state === "needs-install") {
    return (
      <span className="alerts-hint" title="Tap Share → Add to Home Screen, then open the app and enable alerts.">
        🔔 Add to Home Screen for alerts
      </span>
    );
  }
  if (state === "subscribed") {
    return <span className="alerts-on" title="Phone alerts are on">🔔 Alerts on</span>;
  }
  if (state === "denied") {
    return (
      <span className="alerts-hint" title="Re-enable notifications for this app in Settings.">
        🔕 Alerts blocked
      </span>
    );
  }

  return (
    <button className="alerts-btn" onClick={enable}>
      🔔 {state === "error" ? "Retry alerts" : "Enable alerts"}
    </button>
  );
}
