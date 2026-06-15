// Supabase swap point (intentionally not wired up yet).
//
// When you're ready to move off the in-memory store:
//
// 1.  npm install @supabase/supabase-js
// 2.  Create a Supabase project and an `incidents` table. Suggested columns
//     (mirrors lib/types.ts Incident):
//
//       id            text primary key,        -- incident number
//       incident_no   text,
//       type          text,                    -- "AFA", "Chimney fire", ...
//       unit          text,                    -- turnout / station, e.g. "428"
//       location      text,                    -- free-text address, may be ""
//       coords        jsonb,                   -- { lng, lat } | null
//       fields        jsonb,                   -- any extra KEY: value pairs
//       received_at   timestamptz default now(),
//       raw           text
//
// 3.  Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).
// 4.  Re-implement listIncidents()/getIncident()/addRawMessages() in lib/store.ts
//     using the client below. The API routes and UI need no changes.
//
// Example client (uncomment once the package is installed):
//
// import { createClient } from "@supabase/supabase-js";
//
// export const supabase = createClient(
//   process.env.NEXT_PUBLIC_SUPABASE_URL!,
//   process.env.SUPABASE_SERVICE_ROLE_KEY!,
//   { auth: { persistSession: false } },
// );

export {};
