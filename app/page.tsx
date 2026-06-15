import { listIncidents } from "@/lib/store";
import PagerBoard from "@/components/PagerBoard";

export const dynamic = "force-dynamic";

export default function Page() {
  const initial = listIncidents();
  return <PagerBoard initial={initial} />;
}
