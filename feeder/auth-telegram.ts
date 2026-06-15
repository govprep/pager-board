/**
 * One-time Telegram authentication helper.
 * Run: npm run feeder:auth-telegram
 * Copy the printed session string into your .env.local as TG_SESSION=...
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

async function main() {
  let TelegramClient: typeof import("telegram").TelegramClient;
  let StringSession: typeof import("telegram/sessions").StringSession;
  try {
    ({ TelegramClient } = await import("telegram"));
    ({ StringSession } = await import("telegram/sessions"));
  } catch {
    console.error('`telegram` package not found. Run: npm install telegram');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });

  const apiId = Number(process.env.TG_API_ID ?? await rl.question("TG_API_ID (from my.telegram.org/apps): "));
  const apiHash = process.env.TG_API_HASH ?? await rl.question("TG_API_HASH: ");

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: () => rl.question("Phone number (international format, e.g. +61412345678): "),
    password: async () => {
      const pw = await rl.question("2FA password (press Enter if none): ");
      return pw;
    },
    phoneCode: () => rl.question("Telegram verification code: "),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const sessionStr = String(client.session.save());
  console.log("\n✓ Authenticated successfully.\n");
  console.log("Add this to your .env.local:\n");
  console.log(`TG_SESSION=${sessionStr}`);
  console.log(
    "\nAlso set TG_GROUP to the group name, @username, or numeric ID.",
  );

  await client.disconnect();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
