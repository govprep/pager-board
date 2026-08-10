/**
 * A one-at-a-time queue for async work.
 *
 * The board's write path is a read followed by a write: compare a batch against
 * the rows already stored (lib/incident-merge.ts), then upsert what survived.
 * That is only correct if nothing else writes in between — otherwise a thin copy
 * of a page can read the board *before* a fuller copy lands and still overwrite
 * it a moment later, which is the exact case the comparison exists to prevent.
 *
 * Every feeder source runs concurrently in one process, and the same page
 * routinely reaches two of them within the same second, so that window is
 * real rather than theoretical.
 *
 * Scope: this serialises callers sharing one instance, in one process. It is not
 * a distributed lock — a second feeder against the same database would race
 * again, as would a POST to /api/incidents landing at the same moment.
 */
export function makeMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    // `then(fn, fn)` so one caller's failure doesn't wedge the queue for the
    // rest — the next batch runs either way.
    const result = tail.then(fn, fn);
    // The queue only needs to know when this settled, not how it went. The
    // caller owns the outcome (and any rejection) via `result`.
    tail = result.catch(() => {});
    return result;
  };
}
