import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// A PushSubscription serialised by the browser (subscription.toJSON()).
interface SubscriptionBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

// POST /api/push/subscribe — save (or refresh) a device's push subscription.
export async function POST(req: Request) {
  let body: SubscriptionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "Incomplete subscription" }, { status: 422 });
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .upsert({ endpoint, p256dh, auth }, { onConflict: "endpoint" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

// DELETE /api/push/subscribe — remove a device's subscription (unsubscribe).
export async function DELETE(req: Request) {
  let endpoint: string | undefined;
  try {
    endpoint = (await req.json())?.endpoint;
  } catch {
    /* fall through */
  }
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 422 });
  }

  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
