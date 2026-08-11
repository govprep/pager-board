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

// True on phones and tablets.
//
// Asked as a capability rather than a width: a phone held in landscape is wider
// than a narrow desktop window, and it's still the device that wants a
// notification. `hover: none` and `pointer: coarse` together are the pair that
// separates a touchscreen from a mouse — a touch-capable laptop still reports its
// mouse as the primary pointer, so it reads as the desktop it is.
//
// Starts false so the default is the desktop treatment, and flips on mount; the
// component renders nothing while `state` is "loading" anyway, so there's no
// moment where a control appears and then leaves.
function useTouchDevice(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
    setTouch(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setTouch(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return touch;
}

export default function EnableAlerts({ lgaOptions = [] }: { lgaOptions?: LgaOption[] }) {
  const [state, setState] = useState<State>("loading");
  const [showPrefs, setShowPrefs] = useState(false);
  const touch = useTouchDevice();

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
      if (!sub) return;
      // Re-announce a subscription we already hold. It's the only moment a
      // device that enrolled long ago says who it is, so it's where a stale twin
      // left behind by a rotated endpoint gets found and retired — waiting for
      // the user to save preferences would leave the old row pushing for weeks.
      // Idempotent: permission is already granted and the subscription is
      // reused, so nothing prompts.
      await ensureSubscribed();
      // After the reconcile, so a device that inherits the areas it picked on a
      // previous endpoint isn't asked to pick them again.
      await offerPicker();
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

  // Alerts are a phone feature: the point of one is the device in your pocket
  // buzzing about a job you can't see, and on iOS they only work from the
  // installed home-screen app at all. A desktop board is a screen someone is
  // already watching, so the offer is just noise in its topbar.
  //
  // The one state a desktop keeps is "subscribed", because that control is also
  // the only way to reach the area picker and to see that this device has alerts
  // on. Hiding it from a desktop that had already enabled them would leave it
  // notifying with nothing in the UI to turn it off.
  if (!touch && state !== "subscribed") return null;

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
