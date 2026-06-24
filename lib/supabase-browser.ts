import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser singleton — uses the anon key, safe to ship to the client.
// Import this only from client components ("use client").
let _client: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return _client;
}
