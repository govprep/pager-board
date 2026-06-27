"use client";

// Gates the whole board behind an invite code (good for up to a few devices).
//
// Each person gets a short code (and a link that carries it). Entering the code
// at /api/enroll mints THIS device its own durable token, stored in localStorage
// — that's the "never ask again". One code covers up to ~3 devices, which is
// what makes installed iOS PWAs work: a home-screen PWA has its own storage jar,
// so the user simply types the same code inside the PWA to enrol it too. On load
// (and periodically) the gate exchanges the device token for a short-lived access
// token via /api/session, used for the board's API calls and Supabase Realtime.
// Revoke the member and the next exchange is refused (403), showing the form.

import { useEffect, useRef, useState } from "react";
import { getBrowserClient } from "@/lib/supabase-browser";
import PagerBoard from "@/components/PagerBoard";

const STORAGE_KEY = "belterhub.invite"; // this device's durable token
const REFRESH_MS = 45 * 60 * 1000; // re-exchange before the 1h token expires
const RETRY_MS = 10 * 1000;        // quick retry after a transient error

type Phase = "checking" | "need-code" | "revoked" | "authed";

export default function AccessGate() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [codeInput, setCodeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const accessRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelledRef = useRef(false);

  // Enrol this device with a code (typed or from the link). Stores the device
  // token on success; returns an error message otherwise.
  async function enroll(code: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, userAgent: navigator.userAgent }),
      });
      if (res.ok) {
        const { token } = await res.json();
        localStorage.setItem(STORAGE_KEY, token);
        return { ok: true };
      }
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data.error || "Couldn't enrol with that code." };
    } catch {
      return { ok: false, error: "Network error — please try again." };
    }
  }

  // Exchange this device's token for a fresh access token.
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
    getBrowserClient().realtime.setAuth(accessToken); // let Realtime read the locked table
    return "ok";
  }

  // Self-rescheduling session refresh once this device has a token.
  function startSession() {
    async function keepFresh() {
      const token = localStorage.getItem(STORAGE_KEY);
      if (!token) return setPhase("need-code");
      const result = await exchange(token);
      if (cancelledRef.current) return;
      if (result === "revoked") {
        localStorage.removeItem(STORAGE_KEY);
        return setPhase("revoked");
      }
      if (result === "ok") setPhase("authed");
      timerRef.current = setTimeout(keepFresh, result === "ok" ? REFRESH_MS : RETRY_MS);
    }
    keepFresh();
  }

  useEffect(() => {
    cancelledRef.current = false;

    // Pull a code/token off the link, then clean the URL.
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get("code") ?? url.searchParams.get("invite");
    if (fromLink) {
      url.searchParams.delete("code");
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url.toString());
    }

    (async () => {
      if (localStorage.getItem(STORAGE_KEY)) return startSession(); // already enrolled
      if (fromLink) {
        const r = await enroll(fromLink);
        if (cancelledRef.current) return;
        if (r.ok) return startSession();
        setError(r.error ?? null);
      }
      setPhase("need-code"); // ask for the code (the PWA path)
    })();

    return () => {
      cancelledRef.current = true;
      clearTimeout(timerRef.current);
    };
  }, []);

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    const code = codeInput.trim();
    if (!code) return;
    setSubmitting(true);
    setError(null);
    const r = await enroll(code);
    setSubmitting(false);
    if (!r.ok) return setError(r.error ?? "Couldn't enrol with that code.");
    setPhase("checking");
    startSession();
  }

  function signOut() {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  }

  if (phase === "checking") return <div className="auth-screen" />;
  if (phase === "authed") {
    return <PagerBoard getToken={() => accessRef.current} onSignOut={signOut} />;
  }

  // need-code / revoked: the enrolment form.
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="auth-logo" src="/logo.jpg" alt="BelterHub" />
        <form onSubmit={submitCode}>
          <h1 className="auth-title">
            {phase === "revoked" ? "Access removed" : "Enter your code"}
          </h1>
          <p className="auth-sub">
            {phase === "revoked"
              ? "This device's access was turned off. Enter a new code from an admin to get back in."
              : "BelterHub is members-only. Enter the access code an admin gave you. On a phone, add to your home screen first, then enter it here."}
          </p>
          <input
            className="auth-input auth-code"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoFocus
            placeholder="CODE"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
          />
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-btn" type="submit" disabled={submitting}>
            {submitting ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
