import { createClient } from "@supabase/supabase-js";

// Server-side singleton — uses the service role key, never exposed to the browser.
// Only import this from API routes or server components (app/page.tsx, etc.).
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);
