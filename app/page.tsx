import { listIncidents } from "@/lib/store";
import PagerBoard from "@/components/PagerBoard";

export const dynamic = "force-dynamic";

export default async function Page() {
  const initial = await listIncidents();
  return <PagerBoard initial={initial} />;
}
