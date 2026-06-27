/**
 * Manage board access (single-use invite links).
 *
 *   npm run access new "Jane S"          — create a member, print their one-time link
 *   npm run access list                  — show all members + status
 *   npm run access revoke <id|label>     — turn off a member's access
 *   npm run access restore <id|label>    — turn it back on
 *
 * Each link enrols exactly one device, then it's spent. Reads
 * NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local (same
 * config as the app/feeder). BOARD_URL sets the link host (defaults to
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

// Find a member by exact id, else unique case-insensitive label match.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findMember(needle: string): Promise<any | null> {
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

async function create(label: string) {
  if (!label) {
    console.error('Give the member a label:  npm run access new "Jane S"');
    process.exit(1);
  }
  const inviteToken = randomBytes(24).toString("base64url");
  const { data, error } = await db
    .from("members")
    .insert({ label, invite_token: inviteToken })
    .select()
    .single();
  if (error) throw new Error(error.message);
  console.log(`Created ${data.label} (${data.id})`);
  console.log(`One-time invite link — send it to them, works on the first device only:`);
  console.log(`  ${inviteLink(inviteToken)}`);
}

async function list() {
  const { data, error } = await db
    .from("members")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!data?.length) return console.log('No members yet:  npm run access new "Name"');
  for (const m of data) {
    const state = m.revoked_at ? "REVOKED" : m.claimed_at ? "enrolled" : "pending";
    const detail = m.claimed_at
      ? `last seen: ${m.last_seen_at ? new Date(m.last_seen_at).toLocaleString() : "—"}`
      : `link: ${inviteLink(m.invite_token)}`;
    console.log(`${m.id}  ${state.padEnd(8)} ${(m.label || "(no label)").padEnd(18)} ${detail}`);
  }
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
    case "new": return create(arg);
    case "list": return list();
    case "revoke": return setRevoked(arg, true);
    case "restore": return setRevoked(arg, false);
    default:
      console.log('Usage: npm run access <new "Name" | list | revoke <id|label> | restore <id|label>>');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
