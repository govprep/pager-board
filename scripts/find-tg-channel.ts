import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

async function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }

  const client = new TelegramClient(
    new StringSession(process.env.TG_SESSION!),
    Number(process.env.TG_API_ID),
    process.env.TG_API_HASH!,
    { connectionRetries: 3 },
  );

  await client.connect();
  const dialogs = await client.getDialogs({ limit: 200 });
  console.log("Dialogs:");
  for (const d of dialogs) {
    console.log(`  ${String(d.id).padEnd(20)} | ${d.title}`);
  }
  await client.disconnect();
}

main().catch(console.error);
