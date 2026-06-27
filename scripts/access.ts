/**
 * Manage board access (per-member invite links).
 *
 *   npm run access list                 — show all members + status
 *   npm run access new "Jane S"         — create a member, print their invite link
 *   npm run access revoke <id|label>    — turn off a member's access
 *   npm run access restore <id|label>   — turn it back on
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local
 * (same config as the app/feeder). BOARD_URL sets the link host (defaults to
 * http://localhost:3000).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const envPath = join(import.meta.dirname ?? __dirname, "..", ".env.local");
  try {
    const raw = readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
}
loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const boardUrl = (process.env.BOARD_URL || "http://localhost:3000").replace(/\/$/, "");
const db = createClient(url, key, { auth: { persistSession: false } });

function inviteLink(token: string): string {
  return `${boardUrl}/?invite=${token}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findMember(needle: string): Promise<any | null> {
  // Match by exact id first, then by label (case-insensitive).
  const byId = await db.from("members").select("*").eq("id", needle).maybeSingle();
  if (byId.data) return byId.data;
  const byLabel = await db.from("members").select("*").ilike("label", needle).limit(2);
  if (byLabel.data && byLabel.data.length === 1) return byLabel.data[0];
  if (byLabel.data && byLabel.data.length > 1) {
    console.error(`"${needle}" matches multiple members — use the id instead.`);
    process.exit(1);
  }
  return null;
}

async function list() {
  const { data, error } = await db
    .from("members")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!data?.length) return console.log("No members yet. Add one:  npm run access new \"Name\"");
  for (const m of data) {
    const status = m.revoked_at ? "REVOKED" : "active";
    const seen = m.last_seen_at ? new Date(m.last_seen_at).toLocaleString() : "never";
    console.log(`${m.id}  ${status.padEnd(8)} ${(m.label || "(no label)").padEnd(20)} last seen: ${seen}`);
  }
}

async function create(label: string) {
  if (!label) {
    console.error('Give the member a label:  npm run access new "Jane S"');
    process.exit(1);
  }
  const token = randomBytes(24).toString("base64url");
  const { data, error } = await db
    .from("members")
    .insert({ label, token })
    .select()
    .single();
  if (error) throw new Error(error.message);
  console.log(`Created ${data.label} (${data.id})`);
  console.log(`Invite link — send this to them, open on their device:`);
  console.log(`  ${inviteLink(token)}`);
}

async function setRevoked(needle: string, revoked: boolean) {
  const member = await findMember(needle);
  if (!member) {
    console.error(`No member matching "${needle}".`);
    process.exit(1);
  }
  const { error } = await db
    .from("members")
    .update({ revoked_at: revoked ? new Date().toISOString() : null })
    .eq("id", member.id);
  if (error) throw new Error(error.message);
  console.log(`${revoked ? "Revoked" : "Restored"} ${member.label || member.id}.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "list": return list();
    case "new": return create(arg);
    case "revoke": return setRevoked(arg, true);
    case "restore": return setRevoked(arg, false);
    default:
      console.log("Usage: npm run access <list | new \"Name\" | revoke <id|label> | restore <id|label>>");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
