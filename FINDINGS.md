# FilsPay audit — deployment findings and additions

The main audit write-up is **[docs/AUDIT-FIXES.md](docs/AUDIT-FIXES.md)**
(money, security, operations and FP-300 refunds). This file holds what that
document doesn't cover: the problems found while hosting the app on Dilmune
Cloud (D-n), one settlement fix (R-16), and open items.

Each entry: **what's wrong**, **why it happens**, **what it breaks**, and the
fix. Every fixed line carries a `FIX <ID>` comment; `grep -rn "FIX [A-Z]-[0-9]"`
lists them. Source of truth for "correct" is `docs/ARCHITECTURE.md` and
`docs/adr/`. `CLAUDE.md`, `AGENTS.md` and `.cursorrules` contradict them in
several places (cents vs fils, UTC vs Bahrain midnight, `Math.random` for
OTPs, "don't fix the 501"); see the note at the top of AUDIT-FIXES.

Status: **Fixed** · **Open**.

---

## Deployment (Dilmune Cloud)

### D-1. Dockerfiles referenced by compose don't exist — Fixed
- **What:** `ops/docker-compose.yml` builds `ops/Dockerfile.node` and
  `ops/Dockerfile.go`; neither was ever committed (see the AM/MK thread in
  `ops/README.md`).
- **Breaks:** `docker compose up` fails; the app can't be built or hosted.
- **Fix:** `Dockerfile.node` (Node 22 slim, backend workspaces only, cached
  dependency layer), `Dockerfile.go` (static binary, multi-stage so the build
  cache doesn't fill the box's disk) and `Dockerfile.web` (see D-9).

### D-2. Compose never loads `ops/.env.docker` — Fixed
- **What:** the compose header says `.env.docker` is "picked up
  automatically". Compose only auto-reads a file named `.env`, and only for
  `${...}` interpolation. No service had `env_file:`.
- **Breaks:** `NODE_ENV`/`PORT` never reached the api, so it ran in development
  mode. The settlement daemon calls `RequireInternalToken()` and exits at boot
  without `SETTLEMENT_INTERNAL_TOKEN` (FH: "it exits at boot"), so batch close
  and payouts never ran under compose.
- **Fix:** `env_file: .env.docker` on the api; secrets passed explicitly from a
  generated `ops/.env`.

### D-3. Acquirer callback secret committed to git — Fixed (rotate it)
- **What:** `ops/.env.docker` is tracked and contained
  `ACQUIRER_CALLBACK_SIGNING_SECRET`. Its comment says it's gitignored "like
  .env", but the `.env` pattern matches only that exact filename.
- **Breaks:** anyone with the repo can sign acquirer callbacks.
- **Fix:** removed from the committed file; `ops/gen-env.sh` generates
  per-host secrets into the gitignored `ops/.env`. The old value is in git
  history and must be rotated with the acquirer.

### D-4. Postgres exposed to the internet with a known password — Fixed
- **What:** compose published `5432:5432` on all interfaces with password
  `filspay_dev_password`, and published the api on 3000. The README says
  "the hosted demo box runs this same file".
- **Why:** Docker-published ports bypass ufw, so the host firewall doesn't help.
- **Breaks:** the database (ledger, sessions, key hashes) is open to anyone.
- **Fix:** Postgres is bound to `127.0.0.1` with a random password; only the
  nginx proxy is public.

### D-5. `PGCONN_SETTLEMENT` overrides `DATABASE_URL`, contrary to the docs — Fixed (config)
- **What:** `internal/config/config.go` uses `PGCONN_SETTLEMENT` whenever it is
  set. ARCHITECTURE, `ops/README.md` and the compose comment all say it only
  applies when `DATABASE_URL` is unset.
- **Breaks:** pointing the "harmless" variable elsewhere silently moves batch
  close and payouts to another database.
- **Fix:** not set in compose; the comment states the real precedence.

### D-6. Built-in dev webhook key is invalid — Fixed
- **What:** `DEV_FALLBACK_WEBHOOK_KEY_B64` (`apps/api/src/config.ts`) decoded to
  34 bytes; validation requires exactly 32 (AES-256). The compose comment "a
  dev key is used otherwise" was never true.
- **Breaks:** any non-production boot without an explicit key threw in
  `loadConfig`: the api in dev, and the seed script.
- **Fix:** a valid 32-byte dev-only key; production still refuses to boot
  without a real one (`config.fix.test.ts`). Verified: the seed runs with no
  key set.

### D-7. Migrations 0054–0055 fail on a fresh database — Fixed
- **What:** 0054 references `settlement_batch_events`, which no migration
  creates; 0055 inserts `chart_of_accounts` columns 0007 never defined.
- **Breaks:** `migrate` stops at 0054, so the stack can't be installed.
- **Fix:** both corrected in place (AUDIT-FIXES). The console balance rebuild
  that read 0054's view now uses the ledger (AUDIT-FIXES #6, FP-203).

### D-8. No way to log in on a production deployment — Fixed (demo flag)
- **What:** with `NODE_ENV=production`, `sendOtpCode` logs that an OTP exists
  but never the code, and no email/SMS provider is wired.
- **Fix:** `OTP_DEV_EXPOSE=true` in the demo's `ops/.env` (the login pages show
  the code). Demo only: a real deployment needs an OTP provider.

### D-9. Frontends can't reach the API when hosted — Fixed
- **What:** apps/web and apps/admin default to `http://localhost:3000` with cookie
  auth; apps/api has no CORS handling.
- **Breaks:** browsers block every API call from a hosted frontend.
- **Fix:** one origin, one port. nginx serves `/` (web) and `/admin/` (admin)
  and proxies `/v1`. A separate admin port (8081) isn't usable on Dilmune:
  its firewall only opens 22/80/443. The admin router takes `basename` from
  Vite's `BASE_URL`.

### D-10. Node 20 silently runs zero tests — Fixed (images)
- **What:** `cookie@2.0.1` requires Node ≥ 22, and Node 20's test runner
  can't expand `"src/**/*.test.ts"`: it prints "Could not find …" and runs
  nothing for api/reporting/web.
- **Breaks:** every "tests pass" claim made on Node 20 covers zero API tests.
- **Fix:** images use Node 22; run the suites there.

---

## Settlement

### R-16. MDR recalculation erases a batch's refund deduction — Fixed
- **What:** `RecalculateMDR` rewrote `net_payout_fils = gross - newFee`.
- **Why:** since FP-300, `CloseBatch` deducts refunds from the net, so the net
  is no longer `gross - fee`.
- **Breaks:** recalculating MDR on a batch that carried refunds pays the
  refunded money out again.
- **Fix:** `net = oldNet - feeDiff`. It's identical for batches without
  refunds (`recalculate_mdr.go`).

---

## Found after the tickets were done

### H-1. The nightly hold janitor could delete every hold — Fixed
- **What:** `scripts/expire_holds.ts` selected the expired hold ids, then ran
  `buildDelete("holds", { id: ids })`. `lib/sqlFilter.buildWhere` skipped an
  *empty* array, so on a night with nothing expired the statement was
  `DELETE FROM holds`, with no WHERE. The doc comment claimed "a night with
  nothing expired changes no rows".
- **Why else it was wrong:** HANDOVER says holds are flipped to `expired` with
  one UPDATE and never deleted. And a hold captured between the SELECT and the
  DELETE was deleted anyway ("negligible window, fine").
- **Breaks:** the first quiet night wipes the whole authorization-hold history
  (captured and released holds included). The old tests only asserted the
  DELETE's text, so they locked in the deletion and never covered the empty case.
- **Fix:** one atomic `UPDATE holds SET status = 'expired' WHERE status = 'active'
  AND expires_at < now()`. `buildWhere` treats an empty list as `FALSE`, and
  `buildDelete` refuses to emit an unscoped DELETE. The tests now assert the
  behaviour (`scripts/expire_holds.test.ts`).

### K-1. KYC "PDF-only" documents were checked by filename only — Fixed
- **What:** commercial registrations and bank letters must be PDFs, but
  `recordKycDocument` only checked `fileName.endsWith(".pdf")`. The magic-byte
  type was already computed and ignored. MK's "fixed in FP-231" was not true
  for this path.
- **Breaks:** a phone photo (JPEG/PNG) named `CR.pdf` was accepted as a
  registration certificate and stored as an image, so the reviewer approves
  KYC on a document type the policy forbids.
- **Fix:** the bytes must be a PDF too; the existing filename rule stays
  (`apps/api/src/onboarding/kyc.ts`, `kyc.fix.test.ts`).

### A-1. The same finance adjustment sheet could be applied twice — Fixed
- **What:** nothing stopped a second upload of an identical CSV. Huda asked for
  a guard (finance/eng 2026-07-08); FH asked on 14/8 with no answer. The
  comment "re-upload is blocked by the unique original_filename" was wrong:
  no such constraint exists, and a filename doesn't identify content anyway.
- **Breaks:** a double-click, a retry after a timeout, or two people working the
  same email posts every ledger adjustment and balance-cache change again.
- **Fix:** each import stores a SHA-256 fingerprint of its rows, unique in the
  database (migration 0079), so an identical second import, even a concurrent
  one, gets 409 `adjustment_import_already_applied` and posts nothing.
  Existing imports are backfilled with the same formula, so re-uploading a
  sheet applied before the fix is caught too. A sheet with any different
  row is still accepted (`adjustmentImport.fix.test.ts`).

### P-1. Business profile PATCH answered 500 on unknown fields — Fixed
- **What:** the route passes the raw request body to `updateBusinessProfile`,
  which looked every key up in `PATCHABLE_COLUMNS`. An unrecognised key (a
  typo, an extra client field, `__proto__`/`constructor`) produced SQL like
  `undefined = $2`.
- **Why it's not injection:** the column text only ever comes from the fixed
  map (FH asked "injection? claude: yes"; it isn't).
- **Breaks:** any client sending an extra field gets a 500 and the profile isn't
  saved.
- **Fix:** only the documented fields reach the SQL builder; others are
  ignored (`businessProfile.fix.test.ts`).

### T-2. A failed ROLLBACK hid the real error and poisoned the pool — Fixed
- **What:** in `withTransaction` (used by every money operation),
  `await client.query("ROLLBACK")` throws when the connection has died. That
  replaced the original error, and `release()` returned the dead client to the
  pool. Comments from three people noticed this and left it.
- **Breaks:** logs and callers see "Connection terminated" instead of the real
  failure, and the next request that gets that client fails too.
- **Fix:** the original error is always rethrown; a client whose ROLLBACK
  failed is destroyed with `release(err)` (`withTransaction.fix.test.ts`).

### I-1. Admin invite codes used Math.random — Fixed (latent)
- **What:** `generateInviteCode` (admin onboarding) used `Math.random`, which is
  predictable. No route or table uses it yet.
- **Breaks:** once wired up, invite codes (bearer secrets that create an admin
  account) would be guessable.
- **Fix:** `crypto.randomInt` (`config.fix.test.ts`).

### C-1…C-3. False statements in code and agent config — Fixed
- **C-1:** `idempotency.ts` said stale claims are cleaned by
  `scripts/sweep_idempotency.ts` (it never existed) and that refunds commit
  their claim before the acquirer call (no longer true). Corrected.
- **C-2:** removed dead float money helpers with no callers: `SchemeAmountBD`
  (the float scheme amount behind AUDIT-FIXES #2) and `EstimateMonthlyPayout`
  (float32 sum).
- **C-3:** `CLAUDE.md` claimed impersonation is gated to `super_admin` by
  middleware. No such gate exists; ADMIN.md lets support impersonate, and the
  grant is read-only (#23). Corrected that bullet.

---

## Refund IDs used in the Hussain branch → AUDIT-FIXES

Both branches implemented FP-300 independently and found the same bugs. The
merged code uses the AUDIT-FIXES implementation. The extra regression tests
from this branch (`apps/api/src/refunds/refunds.fixes.test.ts`) run against
it.

| ID | Bug | AUDIT-FIXES |
|---|---|---|
| R-1 | refund without a reason violates the 0070 check after the card was refunded | FP-300 |
| R-2 | refundable ceiling used the authorized amount | #20 |
| R-3 | FP-209 concurrent refunds both pay out | #20 |
| R-4 | any merchant could refund another merchant's transaction | #20 |
| R-5 | partial-refund fee reversals don't sum to the fee | FP-300 |
| R-6 | discounted merchants got back the pre-discount fee | FP-300, #12 |
| R-7 | route was a 501 stub; the drafted handler was unsafe | FP-300 |
| R-8/R-9 | no refund webhook; FP-240 signed bytes ≠ sent bytes | FP-300, #21 |
| R-10 | refunds missing from reporting (and its columns missing) | FP-300 (0078) |
| R-11/R-12 | settlement and reconciliation ignored refunds | FP-300, #33 |
| R-13 | refund summary view always empty | FP-300 (0078) |
| R-14/R-15 | timeline crash on negatives; drawer parked and wrong | FP-300 |
| R-17 | net payout in float32 | #3 |

---

## Open

- **F-3. Status after fully refunding a partial capture stays
  `partially_captured`.** This is by design in `refundState.ts`, which keeps
  the remaining authorization open; the refund ceiling prevents any second
  refund. Huda's later rule says it should read "refunded"; finance needs to
  decide.
