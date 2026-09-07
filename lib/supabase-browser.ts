import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser singleton — uses the anon key, safe to ship to the client.
// Import this only from client components ("use client").
let _client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
  }
  return _client;
}

/** Remove a manually supplied Realtime credential when the gate closes. */
export async function clearBrowserAuth(): Promise<void> {
  if (_client) await _client.realtime.setAuth(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
