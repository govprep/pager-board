"use client";

// Short-lived credentials stay in memory and are refreshed by AccessGate.
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void { accessToken = token; }

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!accessToken) throw new Error("Your session has expired. Sign in again.");
  const target = input instanceof Request ? input.url : String(input);
  if (new URL(target, window.location.href).origin !== window.location.origin) {
    throw new Error("Authenticated requests must use this application's origin.");
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(input, { ...init, headers, cache: "no-store", redirect: "error" });
}
