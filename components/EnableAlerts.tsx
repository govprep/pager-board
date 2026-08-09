"use client";

import { useEffect, useState } from "react";
import { pushSupported, ensureSubscribed, getAlertStatus } from "@/lib/push-client";
import AlertPrefsModal, { type LgaOption } from "@/components/AlertPrefs";

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

// Set once we've shown a device the picker unprompted, so it's an offer and not
// a nag. Local to the device, like the subscription it's about.
const PICKER_OFFERED_KEY = "belterhub.alerts.picker-offered";

export default function EnableAlerts({ lgaOptions = [] }: { lgaOptions?: LgaOption[] }) {
  const [state, setState] = useState<State>("loading");
  const [showPrefs, setShowPrefs] = useState(false);

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
      if (sub) void offerPicker();
    });
  }, []);

  // Devices enrolled before the area picker shipped are on "everything" by
  // default — a setting nobody chose and nobody can see. Open the picker for
  // them once, then leave them alone whatever they decide (including closing it,
  // hence the local flag: the server only records an actual save).
  async function offerPicker() {
    try {
      if (localStorage.getItem(PICKER_OFFERED_KEY)) return;
      const { chosen } = await getAlertStatus();
      if (chosen) return;
      localStorage.setItem(PICKER_OFFERED_KEY, "1");
      setShowPrefs(true);
    } catch {
      /* storage blocked or offline — the button still opens it by hand */
    }
  }

  async function enable() {
    try {
      setState("loading");
      const endpoint = await ensureSubscribed();
      if (endpoint) {
        setState("subscribed");
        // Straight into the picker: a device that just enabled alerts is about
        // to receive every incident in the state until it narrows.
        try { localStorage.setItem(PICKER_OFFERED_KEY, "1"); } catch { /* ignore */ }
        setShowPrefs(true);
        return;
      }
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
    return (
      <>
        <button
          className="alerts-on"
          title="Phone alerts are on — tap to choose which areas you're alerted for"
          onClick={() => setShowPrefs(true)}
        >
          🔔 Alerts on
        </button>
        {showPrefs && (
          <AlertPrefsModal lgaOptions={lgaOptions} onClose={() => setShowPrefs(false)} />
        )}
      </>
    );
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
