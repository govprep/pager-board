# Local full-stack audit — 7 September 2026

Scope: repository source, installed dependencies, SQL, and local validation only.
No deployment, Supabase connection, external API request, package download, or
browser session was used. Findings describe the supplied schema; they do not
assert the state of a deployed database.

## Security and correctness

| Finding | Implemented fix |
| --- | --- |
| Anonymous incident POST writes through the service role | POST now requires the same constant-time service-key check as DELETE. Payloads reject non-string entries, more than 500 lines, and lines longer than 8,192 characters. The seed script and README include authentication. |
| `incident_threads` has no RLS | Enable RLS and revoke access from anon/authenticated roles. Service-role feeder access remains available. |
| Incident/raw policies admit every authenticated identity | Policies require an active enrolled device and an active member through a restricted security-definer function. API JWT verification independently checks revocation because service-role reads bypass RLS. |
| Missing JWT configuration can produce insecure behavior | Require a secret of at least 32 characters, HS256, subject/issue/expiry claims, expected audience/role, and bounded token age. |
| Enrollment ignores count errors and can exceed its cap concurrently | A service-only RPC locks the member row before counting and inserting devices. Invalid input, invalid codes, full device slots, and database failures retain distinct responses. |
| Push management accepts unauthenticated requests and client-asserted identity | Every route authenticates the device and checks subscription ownership. Ownership is stored as a foreign key; device hashes are derived on the server. Endpoint and encryption-key validation constrain notification destinations. Revoked and unowned devices are excluded from notification queries. |
| PostgREST cursor interpolation can change filter structure | Validate pagination inputs, quote filter literals, preserve database timestamp precision, and compose search plus cursor filters with the ID tiebreaker. |
| Unhandled or ignored database failures | Incident/raw routes return sanitized JSON failures; enrollment/session/push failures are handled explicitly. Feeder thread lookup/cleanup, push cleanup, and admin-script query errors are checked. Presence stamps remain explicitly best effort. |

## Performance and interface

- Split board and raw-feed imports at the authentication gate. Keep Mapbox in its
  existing deferred component and instantiate it only when the map is visible.
- Batch stand-down lookups by incident number instead of querying for each notice.
- Add indexes for raw-feed filtered pagination, push ownership, subscription
  foreign-key cleanup, and follow expiration.
- Preserve existing narrow incident-list columns. Some wildcard reads remain
  intentional where complete rows or compatibility with optional columns are needed.
- Prevent stale raw-feed/filter responses from mixing datasets; preserve cursor
  ordering when timestamps tie. Guard board snapshots against newer live updates.
- Add retryable feed/search/pagination errors, prevent failed automatic pagination
  loops, and keep failed preference reads from being saved as default settings.
- Handle authentication effect replay, unavailable local storage, Realtime auth
  failures, refresh on foreground/online events, and visible connection status.
- Add loading/error boundaries, modal focus containment/restoration, keyboard tab
  navigation, control names, intrinsic logo sizing, and map error states.
- Retain the existing palette, responsive card/table layouts, safe-area spacing,
  and reduced-motion treatment. Restore map attribution.
- Mark API responses private/no-store and prevent invite-bearing referrer leakage.

The project uses custom device JWTs, not Supabase Auth cookie sessions. There is
no cookie refresh middleware to migrate to `@supabase/ssr`. Introducing that
architecture would change the access model. The server-only service client is
now protected by an import boundary; the shared CLI factory remains usable by
feeder and administration scripts.

## Migration and deployment order

1. Back up the database through the normal deployment process.
2. Apply `supabase/migrations/202609070001_security_hardening.sql` to the existing
   schema. `supabase/schema.sql` includes the equivalent changes for a new setup.
   The migration is an incremental upgrade, not a complete empty-database baseline.
3. Deploy the app and feeder together. Enrollment and push routes require the
   new function and ownership column; they deliberately fail closed if absent.
4. Existing push rows with a matching device hash are backfilled automatically.
   Unmatched legacy rows remain stored but cannot receive notifications. Their
   browsers must register a fresh subscription. Revoked devices stay excluded.
5. HTTP ingestion integrations must send `Authorization: Bearer` with the existing
   service-role credential. This intentional security change closes public writes.

The migration enables member/device revocation for RLS reads immediately; API
checks and feeder eligibility checks take effect when their code is deployed.
Queries or notifications already in flight can finish during a revocation.

## Local validation

- `npm run lint`: offline TypeScript-parser source guardrails covering syntax,
  duplicate JSX attributes, debugger statements, and direct server/private-env
  imports in client components. This is a limited checker, not ESLint. No ESLint
  package is installed; Next.js 16 removed the previous `next lint` command.
- `npm run typecheck`: strict TypeScript validation.
- `npm test`: existing feeder/parser/weather regressions plus JWT/API security,
  push validation, cursor/payload validation, and batched stand-down coverage.
  The React server condition permits testing modules marked `server-only`.
- `npm run build`: production Next.js build, run with telemetry disabled.
- `git diff --check`: patch whitespace validation.

Final results: source checks passed across 84 files; strict type checking passed;
61 tests passed with no failures; the Next.js 16.2.9 production build passed.

SQL was reviewed statically, not executed: no local PostgreSQL/Supabase runtime
was established. RLS behavior, lock concurrency, query plans, real push delivery,
and visual/browser behavior therefore still require deployment-environment QA.
Wildcard searches may still scan large histories; no production table sizes or
query plans were available to justify wide trigram indexes. Enrollment has no
distributed rate limiter in this repository. Multiple independent ingestion
processes also still have a read/compare/write window when merging incidents;
the feeder's in-process mutex cannot serialize separate hosts.
Push endpoint replacement is deduplicated within a browser tab but its database
save/prune sequence is not transactional across independent tabs or processes.
