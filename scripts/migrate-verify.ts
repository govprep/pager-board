/**
 * Prove a new Supabase project can actually serve the board, BEFORE cutting over.
 *
 *   TARGET_SUPABASE_URL=https://<new-ref>.supabase.co \
 *   TARGET_SUPABASE_ANON_KEY=<new anon/publishable key> \
 *   TARGET_SUPABASE_SERVICE_ROLE_KEY=<new service role key> \
 *   TARGET_SUPABASE_JWT_SECRET=<new JWT secret> \
 *   npm run migrate:verify
 *
 * The check that matters is the third one. This board does not use Supabase
 * Auth: /api/session mints its own HS256 token with SUPABASE_JWT_SECRET
 * (lib/access.ts), and both PostgREST and Realtime are expected to accept it
 * because it carries role=authenticated and is signed with the project's
 * shared secret.
 *
 * Supabase has since moved new projects to asymmetric JWT signing keys (ES256)
 * with the legacy symmetric secret as a fallback. If a new project has no
 * usable HS256 secret, that minting path breaks — every board read 401s and the
 * Realtime socket never joins — and it breaks only after the environment has
 * been swapped, which is the worst moment to find out. So this runs first.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { createClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import WebSocket from "ws";

function loadEnvLocal() {
  const envPath = join(import.meta.dirname ?? __dirname, "..", ".env.local");
  try {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // optional
  }
}
loadEnvLocal();

const url = (process.env.TARGET_SUPABASE_URL ?? "").replace(/\/$/, "");
const anonKey = process.env.TARGET_SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY ?? "";
const jwtSecret = process.env.TARGET_SUPABASE_JWT_SECRET ?? "";

let failed = 0;
function report(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** The same token /api/session hands the browser. See lib/access.ts. */
async function mintAccessToken(secret: string): Promise<string> {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("00000000-0000-0000-0000-000000000000")
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

async function main() {
  for (const [name, val] of Object.entries({
    TARGET_SUPABASE_URL: url,
    TARGET_SUPABASE_ANON_KEY: anonKey,
    TARGET_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    TARGET_SUPABASE_JWT_SECRET: jwtSecret,
  })) {
    if (!val) {
      console.error(`${name} is not set`);
      process.exit(1);
    }
  }

  console.log(`verifying ${url}\n`);

  // 1. Schema is present — every table the board touches answers.
  console.log("schema:");
  for (const t of [
    "incidents",
    "pager_messages",
    "members",
    "member_devices",
    "push_subscriptions",
    "incident_subscriptions",
    "incident_threads",
  ]) {
    const res = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    report(t, res.ok, res.ok ? "" : `HTTP ${res.status}`);
  }

  // 2. The raw-feed RPC exists. Ingest calls this on every batch, and a missing
  //    function is silent in the logs until /raw is empty.
  console.log("\nfunctions:");
  const rpc = await fetch(`${url}/rest/v1/rpc/record_pager_messages`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload: [] }),
  });
  report("record_pager_messages()", rpc.ok, rpc.ok ? "" : `HTTP ${rpc.status} ${await rpc.text()}`);

  // 3. RLS is on, and the board's own minted token is accepted.
  console.log("\nauth (the board mints its own HS256 tokens — see lib/access.ts):");
  const anonRead = await fetch(`${url}/rest/v1/incidents?select=id&limit=1`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  const anonRows = anonRead.ok ? ((await anonRead.json()) as unknown[]) : null;
  // RLS passing looks like either a refusal or a 200 carrying nothing — the
  // policy grants select to `authenticated` only, so anon simply matches no
  // rows. Rows coming back is the one bad outcome.
  const anonBlocked = !anonRead.ok || (Array.isArray(anonRows) && anonRows.length === 0);
  report(
    "anonymous read is refused by RLS",
    anonBlocked,
    anonBlocked ? "" : "anon read rows back — check the policy",
  );

  const token = await mintAccessToken(jwtSecret);
  const authedRead = await fetch(`${url}/rest/v1/incidents?select=id&limit=1`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  report(
    "PostgREST accepts a minted HS256 token",
    authedRead.ok,
    authedRead.ok ? "" : `HTTP ${authedRead.status} ${await authedRead.text()}`,
  );

  // 4. Realtime accepts it too, and the incidents table is published. This is
  //    the board's whole live path — a page arrives as a postgres_changes event.
  const joined = await new Promise<string>((resolve) => {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false },
      realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
    });
    client.realtime.setAuth(token);
    const timer = setTimeout(() => {
      client.removeAllChannels();
      resolve("timed out after 15s");
    }, 15_000);
    client
      .channel("migrate-verify")
      .on("postgres_changes", { event: "*", schema: "public", table: "incidents" }, () => {})
      .subscribe((status: string, err?: Error) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          client.removeAllChannels();
          resolve("");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          client.removeAllChannels();
          resolve(`${status}${err ? `: ${err.message}` : ""}`);
        }
      });
  });
  report("Realtime accepts it and incidents is published", joined === "", joined);

  if (failed) {
    console.error(`\n${failed} check(s) failed — do NOT cut over.`);
    console.error(
      "If only the HS256 checks failed, the new project is on asymmetric signing keys:\n" +
        "  Settings > JWT Keys > use the legacy JWT secret, or migrate the old one in.\n" +
        "  Whatever you end up with is what SUPABASE_JWT_SECRET must be set to.",
    );
    process.exit(1);
  }
  console.log("\nall checks passed — this project can serve the board.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
