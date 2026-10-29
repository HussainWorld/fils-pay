# Abandoned migrations — not applied (FIX D-7)

`db/migrate.ts` only reads `*.sql` directly under `db/migrations/`, so
nothing in this folder runs.

0054–0056 are the abandoned PRs described in docs/HANDOVER.md ("Migration
gaps ... no database ever ran them") and the numbers ADR-0005 reserves for
settlement v2. They don't apply on a fresh database:

- 0054 references `settlement_batch_events`, which no migration creates, and
  defines `merchant_payable_position` from truncated scheme-export amounts
  (the source FP-203's console rebuild reads; see ADR-0004 vs HANDOVER).
- 0055 inserts into `chart_of_accounts` columns (`code`, `account_type`,
  `description`) that 0007 never defined.
