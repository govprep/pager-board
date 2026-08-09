import "server-only";

// Writing to push_subscriptions columns that the database may not have yet.
//
// The schema is applied by hand in the Supabase SQL editor, so a deploy can land
// before the migration does. Everything that reads the table already tolerates
// the older shape (a missing alert_all reads as "everything"); this keeps the
// writes tolerant too, so the window between deploy and migration degrades to
// "the new column isn't recorded" instead of "saving your alert areas fails".
//
// PostgREST reports an unknown column as PGRST204, with the column name in the
// message. Anything else is a real error and is handed back to the caller.

function missingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST204" || /column .* does not exist/i.test(error.message ?? "");
}

/**
 * Run a write with the optional columns, and again without them if the database
 * doesn't know them yet. `build` receives the extras to merge into its payload.
 */
interface WriteResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | null;
}

export async function withOptionalColumns<T>(
  extras: Record<string, unknown>,
  // PromiseLike, not Promise: Supabase query builders are thenable but aren't
  // promises until awaited.
  run: (extras: Record<string, unknown>) => PromiseLike<WriteResult<T>>,
): Promise<WriteResult<T>> {
  const first = await run(extras);
  if (!missingColumn(first.error)) return first;
  console.warn(
    `[push] database is missing ${Object.keys(extras).join(", ")} — ` +
      "apply supabase/schema.sql; saving without it for now",
  );
  return run({});
}
