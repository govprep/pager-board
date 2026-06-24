import type { PostFn } from "../poster";
import { isValidPagerLine } from "../filter";

const BASE_URL = "https://pocsag.net";

// Shape of a pocsag.net "messagePost" payload (only the fields we use).
interface PocsagMessage {
  message?: string;
  timestamp?: number; // Unix seconds
  agency?: string;
  ignore?: number | null;
}

export async function pollPocsag(post: PostFn): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let io: any;
  try {
    io = (await import("socket.io-client")).default ?? (await import("socket.io-client"));
  } catch {
    console.error("[pocsag] socket.io-client not installed — run: npm install socket.io-client@2");
    return;
  }

  const socket = io(BASE_URL, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 30_000,
  });

  socket.on("connect", () => console.log("[pocsag] connected via Socket.IO"));
  socket.on("disconnect", (reason: string) => console.warn("[pocsag] disconnected:", reason));
  socket.on("connect_error", (err: Error) => console.warn("[pocsag] connect error:", err.message));

  // Each live page arrives as a "messagePost" event carrying one message object.
  socket.on("messagePost", (msg: PocsagMessage) => {
    if (!msg || typeof msg.message !== "string") return;
    if (msg.ignore) return;
    // Honour the project-wide rule: SES traffic is ignored entirely.
    if (/^SES$/i.test(msg.agency ?? "")) return;

    const raw = msg.message.trim();
    if (!isValidPagerLine(raw)) return;

    const receivedAt = msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined;

    post([{ raw, receivedAt }], "pocsag").catch((err) =>
      console.error("[pocsag]", err instanceof Error ? err.message : err),
    );
  });
}
