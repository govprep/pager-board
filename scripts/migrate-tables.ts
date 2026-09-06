/**
 * The tables a project migration carries, and the order they must be written in.
 *
 * Its own module rather than an export from migrate-dump.ts, because importing
 * that file would run its top-level main() as a side effect — the restore would
 * kick off a dump before doing anything else.
 *
 * Order matters on restore: a child row can't land before the row it
 * references. member_devices.member_id -> members.id and
 * incident_subscriptions.endpoint -> push_subscriptions.endpoint are both real
 * foreign keys (`on delete cascade`); the rest stand alone.
 */
export interface MigratedTable {
  name: string;
  /**
   * A single column to sort by while paging the dump. Only needs to be stable
   * and unique enough that `limit`/`offset` doesn't skip or repeat a row.
   */
  orderBy: string;
  /**
   * The conflict target for the restore's upsert — the table's full primary
   * key, composite included. See supabase/schema.sql.
   */
  conflict: string;
}

export const TABLES: MigratedTable[] = [
  { name: "members", orderBy: "id", conflict: "id" },
  { name: "member_devices", orderBy: "id", conflict: "id" },
  { name: "push_subscriptions", orderBy: "endpoint", conflict: "endpoint" },
  // Composite primary key (incident_no, endpoint).
  { name: "incident_subscriptions", orderBy: "incident_no", conflict: "incident_no,endpoint" },
  { name: "incidents", orderBy: "id", conflict: "id" },
  { name: "incident_threads", orderBy: "incident_no", conflict: "incident_no" },
  { name: "pager_messages", orderBy: "hash", conflict: "hash" },
];
