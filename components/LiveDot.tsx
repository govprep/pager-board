"use client";

// Whether the board is still being pushed to.
//
// When the Realtime socket drops, the board falls back to a 30s heartbeat poll
// and otherwise looks identical — which is the worst thing a live incident board
// can do, because "nothing new" and "nothing arriving" read the same. This says
// which one you're looking at.
//
// Three states, not two: joining the channel takes a moment on a cold load, and
// a board that opened half a second ago hasn't lost anything yet — announcing
// "reconnecting" there would cry wolf on every single load.
export type LiveState = "connecting" | "live" | "down";

const LABEL: Record<LiveState, string> = {
  connecting: "CONNECTING",
  live: "LIVE",
  down: "RECONNECTING",
};

const TITLE: Record<LiveState, string> = {
  connecting: "Connecting to the live feed…",
  live: "Connected — incidents appear the moment they're paged",
  down: "Reconnecting — the board is falling back to a refresh every 30 seconds",
};

export default function LiveDot({ state }: { state: LiveState }) {
  return (
    <div className={`live ${state}`} title={TITLE[state]}>
      <span className="live-dot" aria-hidden="true" />
      <span className="live-label">{LABEL[state]}</span>
    </div>
  );
}
