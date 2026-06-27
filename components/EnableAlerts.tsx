"use client";

import { useEffect, useState } from "react";
import { pushSupported, ensureSubscribed } from "@/lib/push-client";

type State =
  | "loading"       // figuring out support/permission
  | "unsupported"   // browser can't do push at all
  | "needs-install" // iOS Safari tab — must Add to Home Screen first
  | "prompt"        // ready, awaiting the user's tap
  | "subscribed"    // good to go
  | "denied"        // user blocked notifications
  | "error";

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
    if (!pushSupported()) {
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
      const endpoint = await ensureSubscribed();
      if (endpoint) return setState("subscribed");
      // ensureSubscribed returns null on denial or a failed save — distinguish.
      setState(Notification.permission === "denied" ? "denied" : "error");
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
