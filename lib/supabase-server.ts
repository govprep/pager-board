import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import WebSocket from "ws";

// Every server-side Supabase client (API routes, the feeder, one-off scripts)
// goes through here rather than calling createClient() directly.
//
// @supabase/supabase-js builds a Realtime client at construction time no
// matter what you actually use the client for, and that constructor throws
// outright on Node < 22 ("Node.js 20 detected without native WebSocket
// support") unless it's handed a WebSocket implementation itself — hit for
// real running the feeder on a Node 20 host. None of these callers subscribe
// to a channel (that's the browser's job — lib/supabase-browser.ts), but the
// client still has to construct one to exist at all.
export function createServerClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false },
    // `ws`'s constructor typings carry a server-mode overload
    // (`new (address: null, ...)`) that doesn't structurally match
    // WebSocketLikeConstructor — harmless at runtime, since the client-mode
    // overload it's actually invoked with is compatible.
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
}
