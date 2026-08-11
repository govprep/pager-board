"use client";

import { useEffect, useState } from "react";
import { fmtTime } from "@/lib/time";

// The topbar's wall clock, deliberately its own component.
//
// It ticks every second, and a second is a long time on a board holding several
// hundred incident rows: while this state lived in PagerBoard, every tick
// re-rendered the whole table — all the badges, tags and addresses — to move one
// digit. Owning the interval here means the tick stops at this element, and the
// board only re-renders when the incidents actually change.
//
// Starts null so the server render and the first client render agree (the time
// is per-device); "--:--:--" holds the width until the first tick lands.
export default function Clock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="clock">{now ? fmtTime(now.toISOString(), true) : "--:--:--"}</div>
  );
}
