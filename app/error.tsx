"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="empty" role="alert">
      <h1>Unable to show the board</h1>
      <p>Something went wrong. Please try again.</p>
      <button className="chip" onClick={reset}>Try again</button>
    </main>
  );
}
