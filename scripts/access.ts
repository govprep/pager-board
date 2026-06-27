/**
 * Manage board access (invite codes — up to a few devices each).
 *
 *   npm run access new "Jane S"          — create a member, print their code + link
 *   npm run access list                  — show members, device usage, status
 *   npm run access revoke <id|label>     — turn off a member (boots all its devices)
 *   npm run access restore <id|label>    — turn it back on
 *
 * One code enrols up to max_devices (default 3) — enough for a Safari tab, the
 * installed PWA, and a spare. Reads NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY from .env.local. BOARD_URL sets the link host.
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

// Short, unambiguous code — no 0/O/1/I to misread when typing on a phone.
function genCode(): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alpha[bytes[i] % alpha.length];
  return s;
}

function inviteLink(code: string): string {
  return `${boardUrl}/?code=${code}`;
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
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const clash = await db.from("members").select("id").eq("code", code).maybeSingle();
    if (!clash.data) break;
    code = genCode();
  }
  const { data, error } = await db
    .from("members")
    .insert({ label, code, max_devices: 3 })
    .select()
    .single();
  if (error) throw new Error(error.message);
  console.log(`Created ${data.label} (${data.id})`);
  console.log(`  Code: ${data.code}   (works on up to ${data.max_devices} devices)`);
  console.log(`  Link: ${inviteLink(data.code)}`);
  console.log(`On a phone: add to home screen first, then enter the code in the app.`);
}

async function list() {
  const { data: members, error } = await db
    .from("members")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (!members?.length) return console.log('No members yet:  npm run access new "Name"');

  const { data: devices } = await db
    .from("member_devices")
    .select("member_id, revoked_at");
  const used = new Map<string, number>();
  for (const d of devices ?? []) {
    if (!d.revoked_at) used.set(d.member_id, (used.get(d.member_id) ?? 0) + 1);
  }

  for (const m of members) {
    const status = m.revoked_at ? "REVOKED" : "active";
    const n = used.get(m.id) ?? 0;
    console.log(
      `${m.id}  ${status.padEnd(8)} ${(m.label || "(no label)").padEnd(18)} ` +
        `code ${String(m.code).padEnd(9)} devices ${n}/${m.max_devices}`,
    );
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
