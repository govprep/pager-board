"use client";

// Gates the whole board behind a single-use invite link.
//
// Each person gets their own one-time link, https://board/?invite=<token>. The
// first device to open it redeems it at /api/enroll for a per-device token it
// stores in localStorage — that's the "never ask again": the device keeps its
// own durable credential and the link is then spent (no second device can use
// it). On load (and periodically) the gate exchanges that device token for a
// short-lived access token via /api/session, used for the board's API calls and
// Supabase Realtime. Revoke the member and the next exchange is refused (403),
// clearing the device and showing "access removed".

import { useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase-browser";
import PagerBoard from "@/components/PagerBoard";

const INVITE_PARAM = "invite";
const STORAGE_KEY = "belterhub.invite"; // this device's durable token
const REFRESH_MS = 45 * 60 * 1000; // re-exchange before the 1h token expires
const RETRY_MS = 10 * 1000;        // quick retry after a transient error

type Phase = "checking" | "no-invite" | "revoked" | "authed";

export default function AccessGate() {
  const [phase, setPhase] = useState<Phase>("checking");
  const accessRef = useRef<string | null>(null);

  // Redeem a reusable invite link for this device's own durable token.
  // Returns "ok" | "bad-invite" (disabled/unknown link) | "error" (transient).
  async function enroll(invite: string): Promise<"ok" | "bad-invite" | "error"> {
    let res: Response;
    try {
      res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite, userAgent: navigator.userAgent }),
      });
    } catch {
      return "error";
    }
    if (res.status === 403) return "bad-invite";
    if (!res.ok) return "error";
    const { token } = await res.json();
    localStorage.setItem(STORAGE_KEY, token);
    return "ok";
  }

  // Exchange this device's durable token for a fresh access token.
  // Returns "ok" | "revoked" | "error" (error = transient, keep the credential).
  async function exchange(token: string): Promise<"ok" | "revoked" | "error"> {
    let res: Response;
    try {
      res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch {
      return "error";
    }
    if (res.status === 403) return "revoked";
    if (!res.ok) return "error";
    const { accessToken } = await res.json();
    accessRef.current = accessToken;
    // Hand the token to Realtime so the locked incidents table streams to us.
    getBrowserClient().realtime.setAuth(accessToken);
    return "ok";
  }

  useEffect(() => {
    // Pull the invite token off the link, then clean it from the URL.
    const url = new URL(window.location.href);
    const inviteFromLink = url.searchParams.get(INVITE_PARAM);
    if (inviteFromLink) {
      url.searchParams.delete(INVITE_PARAM);
      window.history.replaceState({}, "", url.toString());
    }

    // Self-rescheduling: enroll once if needed, then exchange on a normal
    // cadence, retrying quickly on transient errors and locking out on revoke.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    async function keepFresh() {
      // Step 1: make sure this device has a durable token (enroll if not).
      if (!localStorage.getItem(STORAGE_KEY)) {
        if (!inviteFromLink) return setPhase("no-invite");
        const r = await enroll(inviteFromLink);
        if (cancelled) return;
        if (r === "bad-invite") return setPhase("revoked");
        if (r === "error") {
          timer = setTimeout(keepFresh, RETRY_MS);
          return;
        }
      }

      // Step 2: exchange the device token for a short-lived access token.
      const token = localStorage.getItem(STORAGE_KEY)!;
      const result = await exchange(token);
      if (cancelled) return;
      if (result === "revoked") {
        localStorage.removeItem(STORAGE_KEY);
        return setPhase("revoked");
      }
      if (result === "ok") setPhase("authed");
      timer = setTimeout(keepFresh, result === "ok" ? REFRESH_MS : RETRY_MS);
    }
    keepFresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  function signOut() {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }

  if (phase === "checking") return <div className="auth-screen" />;

  if (phase === "authed") {
    return <PagerBoard getToken={() => accessRef.current} onSignOut={signOut} />;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="auth-logo" src="/logo.jpg" alt="BelterHub" />
        <h1 className="auth-title">
          {phase === "revoked" ? "Access removed" : "Invite required"}
        </h1>
        <p className="auth-sub">
          {phase === "revoked"
            ? "This device's access has been turned off. Ask an admin for a new invite link."
            : "BelterHub is members-only. Open the invite link an admin sent you on this device to get in."}
        </p>
      </div>
    </div>
  );
}
