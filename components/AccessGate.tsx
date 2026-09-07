"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import logo from "@/public/logo.jpg";
import { clearBrowserAuth, getBrowserClient } from "@/lib/supabase-browser";
import { setAccessToken } from "@/lib/session-client";

const STORAGE_KEY = "belterhub.invite";
const REFRESH_MS = 45 * 60 * 1000;
const RETRY_MS = 10 * 1000;
let memoryToken: string | null = null;

function LoadingScreen() {
  return <div className="auth-screen" role="status"><p className="auth-sub">Loading your board…</p></div>;
}

const PagerBoard = dynamic(() => import("@/components/PagerBoard"), { loading: LoadingScreen });
const RawFeed = dynamic(() => import("@/components/RawFeed"), { loading: LoadingScreen });
type Phase = "checking" | "need-code" | "revoked" | "authed";
type Enrollment = { token: string; error?: never } | { token?: never; error: string };

function readDeviceToken(): string | null {
  try {
    memoryToken = localStorage.getItem(STORAGE_KEY) ?? memoryToken;
  } catch {
    // Browsers with unavailable storage can still use a session in this tab.
  }
  return memoryToken;
}

function storeDeviceToken(token: string | null) {
  memoryToken = token;
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Keep the credential in memory if persistent storage is unavailable.
  }
}

async function enroll(code: string): Promise<Enrollment> {
  try {
    const res = await fetch("/api/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, userAgent: navigator.userAgent }),
    });
    const data = await res.json();
    if (res.ok && typeof data.token === "string" && data.token) {
      storeDeviceToken(data.token);
      return { token: data.token };
    }
    return { error: typeof data.error === "string" ? data.error : "Couldn't enrol with that code." };
  } catch {
    return { error: "Network error — please try again." };
  }
}

export default function AccessGate({ view = "board" }: { view?: "board" | "raw" }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [deviceToken, setDeviceToken] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const accessRef = useRef<string | null>(null);
  // Effect replay in StrictMode must await the same enrollment, not use another slot.
  const initialEnrollment = useRef<Promise<Enrollment> | null>(null);
  const generation = useRef(0);
  const submittingRef = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get("code") ?? url.searchParams.get("invite");
    if (url.searchParams.has("code") || url.searchParams.has("invite")) {
      url.searchParams.delete("code");
      url.searchParams.delete("invite");
      window.history.replaceState(window.history.state, "", url.toString());
    }
    const saved = readDeviceToken();
    if (!saved && fromLink && !initialEnrollment.current) initialEnrollment.current = enroll(fromLink);
    async function initialize() {
      if (saved) {
        setDeviceToken(saved);
        return;
      }
      if (initialEnrollment.current) {
        const result = await initialEnrollment.current;
        if (cancelled) return;
        if (result.token) {
          setDeviceToken(result.token);
          return;
        }
        setError(result.error ?? null);
      }
      if (!cancelled) setPhase("need-code");
    }
    void initialize();
    function storageChanged(event: StorageEvent) {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      memoryToken = event.newValue;
      setDeviceToken(event.newValue);
      setPhase(event.newValue ? "checking" : "need-code");
    }
    window.addEventListener("storage", storageChanged);
    return () => {
      cancelled = true;
      if (generation.current === current) generation.current++;
      window.removeEventListener("storage", storageChanged);
    };
  }, []);

  useEffect(() => {
    if (!deviceToken) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = 0;
    const controller = new AbortController();

    function clearAccess() {
      accessRef.current = null;
      setAccessToken(null);
      void clearBrowserAuth().catch(() => console.error("Unable to clear Realtime authentication"));
    }

    async function keepFresh() {
      if (cancelled || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      let delay = RETRY_MS;
      try {
        const res = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: deviceToken }),
          signal: controller.signal,
        });
        if (cancelled) return;
        if (res.status === 403) {
          clearAccess();
          storeDeviceToken(null);
          setDeviceToken(null);
          setPhase("revoked");
          return;
        }
        if (!res.ok) throw new Error("Session unavailable");
        const data = await res.json();
        if (typeof data.accessToken !== "string" || !data.accessToken) throw new Error("Invalid session");
        if (cancelled) return;
        await getBrowserClient().realtime.setAuth(data.accessToken);
        if (cancelled) return;
        accessRef.current = data.accessToken;
        setAccessToken(data.accessToken);
        // Refresh at 45 minutes; stop rendering authenticated content on expiry.
        expiresAt = Date.now() + 59 * 60 * 1000;
        setError(null);
        setPhase("authed");
        delay = REFRESH_MS;
      } catch {
        if (cancelled) return;
        setError("Unable to connect. Retrying shortly…");
        if (Date.now() >= expiresAt) {
          clearAccess();
          setPhase("checking");
        }
      } finally {
        inFlight = false;
        if (!cancelled && memoryToken) timer = setTimeout(() => void keepFresh(), delay);
      }
    }
    function refreshOnReturn() {
      if (document.visibilityState === "visible") void keepFresh();
    }
    document.addEventListener("visibilitychange", refreshOnReturn);
    window.addEventListener("online", refreshOnReturn);
    void keepFresh();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      clearAccess();
      document.removeEventListener("visibilitychange", refreshOnReturn);
      window.removeEventListener("online", refreshOnReturn);
    };
  }, [deviceToken]);

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    const code = codeInput.trim();
    if (!code || submittingRef.current) return;
    submittingRef.current = true;
    const current = generation.current;
    setSubmitting(true);
    setError(null);
    const result = await enroll(code);
    submittingRef.current = false;
    if (generation.current !== current) return;
    setSubmitting(false);
    if (!result.token) {
      setError(result.error ?? "Couldn't enrol with that code.");
      return;
    }
    setPhase("checking");
    setDeviceToken(result.token);
  }

  function signOut() {
    storeDeviceToken(null);
    accessRef.current = null;
    setAccessToken(null);
    setDeviceToken(null);
    setError(null);
    setPhase("need-code");
  }

  if (phase === "checking") {
    return (
      <div className="auth-screen" role="status" aria-live="polite">
        <div className="auth-card">
          <p className="auth-title">Connecting to BelterHub</p>
          <p className="auth-sub">{error ?? "Checking this device's access…"}</p>
        </div>
      </div>
    );
  }
  if (phase === "authed") {
    return view === "raw"
      ? <RawFeed getToken={() => accessRef.current} />
      : <PagerBoard getToken={() => accessRef.current} onSignOut={signOut} />;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <Image className="auth-logo" src={logo} alt="BelterHub" priority sizes="100px" />
        <form onSubmit={submitCode} aria-busy={submitting}>
          <h1 className="auth-title">{phase === "revoked" ? "Access removed" : "Enter your code"}</h1>
          <p className="auth-sub" id="access-help">
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
            aria-label="Access code"
            aria-describedby={error ? "access-help access-error" : "access-help"}
            aria-invalid={!!error}
            required
            maxLength={256}
            disabled={submitting}
            placeholder="CODE"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
          />
          {error && <p className="auth-error" id="access-error" role="alert">{error}</p>}
          <button className="auth-btn" type="submit" disabled={submitting || !codeInput.trim()}>
            {submitting ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
