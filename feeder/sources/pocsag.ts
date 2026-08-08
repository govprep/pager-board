import type { PostFn } from "../poster";

const BASE_URL = "https://pocsag.net";

// Shape of a pocsag.net "messagePost" payload (only the fields we use).
interface PocsagMessage {
  message?: string;
  timestamp?: number; // Unix seconds
  agency?: string;
  address?: string | number; // capcode
  alias?: string | null;     // brigade/station name for that capcode
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

    const raw = msg.message.trim();
    if (!raw) return;

    const receivedAt = msg.timestamp
      ? new Date(msg.timestamp * 1000).toISOString()
      : undefined;

    // Everything pocsag.net emits is recorded in the raw feed — the board filter
    // runs in poster.ts. Two source-specific rules still bar a line from the
    // board: pocsag's own `ignore` flag, and the project-wide rule that SES
    // traffic never reaches the board (the agency field catches SES pages whose
    // text alone wouldn't give them away).
    const boardEligible = !msg.ignore && !/^SES$/i.test(msg.agency ?? "");

    post(
      [{
        raw,
        receivedAt,
        boardEligible,
        capcode: msg.address != null ? String(msg.address) : null,
        agency: msg.agency ?? null,
        origin: msg.alias ?? null,
      }],
      "pocsag",
    ).catch((err) => console.error("[pocsag]", err instanceof Error ? err.message : err));
  });
}
