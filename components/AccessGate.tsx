"use client";

// Gates the whole board behind a per-member invite link.
//
// Each member gets a unique link, https://board/?invite=<token>. Opening it
// stores that token in localStorage as the device's durable credential — that's
// the "never ask again": no login screen ever again on this device. On load (and
// periodically) the gate exchanges the stored token for a short-lived access
// token via /api/session, which the board uses for its API calls and Supabase
// Realtime. Revoke a member in the DB and their next exchange is refused (403),
// which clears the device and shows the "access removed" screen.

import { useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase-browser";
import PagerBoard from "@/components/PagerBoard";

const INVITE_PARAM = "invite";
const STORAGE_KEY = "belterhub.invite";
const REFRESH_MS = 45 * 60 * 1000; // re-exchange before the 1h token expires
const RETRY_MS = 10 * 1000;        // quick retry after a transient exchange error

type Phase = "checking" | "no-invite" | "revoked" | "authed";

export default function AccessGate() {
  const [phase, setPhase] = useState<Phase>("checking");
  const accessRef = useRef<string | null>(null);

  // Exchange the durable invite token for a fresh access token.
  // Returns "ok" | "revoked" | "error" (error = transient, keep the credential).
  async function exchange(invite: string): Promise<"ok" | "revoked" | "error"> {
    let res: Response;
    try {
      res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: invite }),
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
    // An invite link (?invite=…) enrolls this device, then we clean the URL.
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get(INVITE_PARAM);
    if (fromLink) {
      localStorage.setItem(STORAGE_KEY, fromLink);
      url.searchParams.delete(INVITE_PARAM);
      window.history.replaceState({}, "", url.toString());
    }

    const invite = localStorage.getItem(STORAGE_KEY);
    if (!invite) return setPhase("no-invite");

    // Self-rescheduling refresh: normal cadence on success, quick retry on a
    // transient error (so an offline first load recovers in seconds, not 45min),
    // and stop + lock out on an explicit revoke.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    async function keepFresh() {
      const result = await exchange(invite!);
      if (cancelled) return;
      if (result === "revoked") {
        localStorage.removeItem(STORAGE_KEY);
        return setPhase("revoked");
      }
      // Render the board once we have a token; on a transient error keep the
      // credential and retry soon (the board's own poll also recovers).
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
            ? "This device's access has been turned off. Ask a coordinator for a new invite link."
            : "BelterHub is members-only. Open the invite link a coordinator sent you on this device to get in."}
        </p>
      </div>
    </div>
  );
}
