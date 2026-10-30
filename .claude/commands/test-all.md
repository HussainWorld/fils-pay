---
description: Run every test suite (TS workspaces, API on a fresh DB, reporting, scripts, Go) and summarise
---
Run `scripts/ai/run_suites.sh` from the repo root (needs the local `ops-postgres-1`
container; it creates a fresh, migrated database per suite and seeds the scripts DB).
Then run the web, money and events suites with `npx tsx --test` on their test files.
Report a table of suite → tests/pass/fail. If anything fails, show the failing test
name and the assertion, and say whether the failure is environmental (no
DATABASE_URL, unseeded DB) or real. Do not edit locked tests to make them pass.
