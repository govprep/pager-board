import { createServerClient } from "./supabase-server";

// Server-side singleton — uses the service role key, never exposed to the browser.
// Only import this from API routes or server components (app/page.tsx, etc.).
export const supabase = createServerClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
