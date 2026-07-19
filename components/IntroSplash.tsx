"use client";

// Full-screen "landing" splash: plays the intro sound, spins the logo, then
// fades away to reveal the site (already rendered underneath). Browsers block
// audio autoplay without a prior user gesture, so a blocked play() just skips
// straight to the fade — the site should never be stuck behind a silent splash.

import { useEffect, useRef, useState } from "react";

const FADE_MS = 600;
const FALLBACK_MS = 6000; // in case audio never loads/fires `ended`

export default function IntroSplash({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    function finish() {
      if (doneRef.current) return;
      doneRef.current = true;
      setFading(true);
      setTimeout(onDone, FADE_MS);
    }

    const audio = audioRef.current;
    audio?.play().catch(finish);

    const fallback = setTimeout(finish, FALLBACK_MS);
    audio?.addEventListener("ended", finish);
    return () => {
      clearTimeout(fallback);
      audio?.removeEventListener("ended", finish);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`intro-splash${fading ? " intro-splash-out" : ""}`}>
      <audio ref={audioRef} src="/intro.mp3" preload="auto" />
      <img className="intro-logo" src="/logo.jpg" alt="" />
    </div>
  );
}
