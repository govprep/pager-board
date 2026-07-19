"use client";

// Renders the real site immediately (underneath) and layers the intro splash
// on top until it finishes, so the splash's fade-out reveals an already-ready site.

import { useState } from "react";
import IntroSplash from "./IntroSplash";

export default function IntroGate({ children }: { children: React.ReactNode }) {
  const [showIntro, setShowIntro] = useState(true);

  return (
    <>
      {children}
      {showIntro && <IntroSplash onDone={() => setShowIntro(false)} />}
    </>
  );
}
