# FilsPay audit — findings

Each entry: **what's wrong**, **why it happens**, **what it breaks**, and
the fix. Source of truth for "correct" behaviour is `docs/ARCHITECTURE.md`
and `docs/adr/` (per the briefing). Where `CLAUDE.md`, `AGENTS.md` or
`.cursorrules` contradict the ADRs, the ADRs win; see A-0.

Status: **Fixed** (in this branch) · **Open** (found, not fixed yet).

Every fixed line in the code carries a `FIX <ID>` comment (e.g. `# FIX D-4: ...`)
saying what was wrong and what the line does now. `grep -rn "FIX [A-Z]-[0-9]"` lists them.

---

## A-0. AI-assistant config files contradict the ADRs — Open (process)

- **What:** `CLAUDE.md`, `AGENTS.md` and `.cursorrules` tell coding agents
  that amounts are cents (1 BD = 100), settlement closes at UTC midnight,
  `Math.random` is fine for OTPs, the refund 501 and the missing
  `refund.succeeded` webhook are intentional, and tests and
  `packages/money` must never change.
- **Why:** ADR-0001 says 1 BD = 1000 fils; ARCHITECTURE says the business day
  is Asia/Bahrain midnight; HANDOVER and ONBOARDING (FP-212) say refunds are
  unfinished work. Several "locked" tests assert the buggy behaviour (e.g. the
  CSV import test expects `4.75` → 475 fils, the route test expects 501).
- **Breaks:** an agent that obeys these files preserves the money, timezone
  and security bugs and refuses to finish the feature.

---

## Deployment (found while hosting on Dilmune Cloud)

### D-1. Dockerfiles referenced by compose don't exist — Fixed
- **What:** `ops/docker-compose.yml` builds `ops/Dockerfile.node` and
  `ops/Dockerfile.go`; neither was ever committed (see the AM/MK thread in
  `ops/README.md`).
- **Breaks:** `docker compose up` fails; the app can't be built or hosted.
- **Fix:** added `Dockerfile.node` (Node 22, see D-9), `Dockerfile.go`
  (static binary, multi-stage so the build cache doesn't fill the disk) and
  `Dockerfile.web`.

### D-2. Compose never loads `ops/.env.docker` — Fixed
- **What:** the compose header says `.env.docker` is "picked up
  automatically". Compose only auto-reads a file named `.env`, and only for
  `${...}` interpolation. No service had `env_file:`.
- **Why it matters:** `NODE_ENV`, `PORT` and `ACQUIRER_CALLBACK_SIGNING_SECRET`
  never reached a container, so the api ran in development mode. The
  settlement daemon calls `RequireInternalToken()` and exits at boot because
  `SETTLEMENT_INTERNAL_TOKEN` was never set (FH noticed: "it exits at boot").
- **Breaks:** settlement (batch close, payouts) never ran under compose; the
  api ran with dev defaults.
- **Fix:** `env_file: .env.docker` on the api; secrets passed explicitly from
  a generated `ops/.env`.

### D-3. Acquirer callback secret committed to git — Fixed (rotate it)
- **What:** `ops/.env.docker` is tracked and contains
  `ACQUIRER_CALLBACK_SIGNING_SECRET`. Its comment says it's gitignored "like
  .env", but the `.env` pattern matches only that exact filename.
- **Breaks:** anyone with the repo can sign acquirer callbacks (fake
  "payment captured" notifications) wherever signature checking is enabled.
- **Fix:** removed from the committed file; `ops/gen-env.sh` generates
  per-host secrets into the gitignored `ops/.env`. The old value is in git
  history and must be treated as leaked.

### D-4. Postgres exposed to the internet with a known password — Fixed
- **What:** compose published `5432:5432` (all interfaces) with password
  `filspay_dev_password`, and published the api on 3000. The README says
  "the hosted demo box runs this same file".
- **Why:** Docker-published ports bypass ufw, so the host firewall doesn't
  help.
- **Breaks:** the whole database (ledger, sessions, API key hashes) is
  readable and writable by anyone who scans the box.
- **Fix:** Postgres is bound to `127.0.0.1` with a random password; only the
  nginx proxy is public.

### D-5. `PGCONN_SETTLEMENT` overrides `DATABASE_URL`, contrary to the docs — Fixed (config)
- **What:** `apps/settlement/internal/config/config.go` uses
  `PGCONN_SETTLEMENT` whenever it is set. ARCHITECTURE, `ops/README.md` and
  the compose comment all say it "only takes effect when `DATABASE_URL` is
  unset" / "is ignored".
- **Breaks:** pointing the "harmless" variable at a replica or another
  database silently moves batch close and payouts there.
- **Fix:** removed from compose, with a comment on the real precedence. The
  code is unchanged.

### D-6. Built-in dev webhook key is invalid — Open
- **What:** `DEV_FALLBACK_WEBHOOK_KEY_B64` in `apps/api/src/config.ts`
  decodes to 34 bytes; `parseWebhookSecretEncryptionKey` requires exactly 32.
- **Breaks:** any non-production boot without an explicit key throws in
  `loadConfig`. That covers the api in dev and the seed script (which calls
  `loadConfig`). The compose comment "a dev key is used otherwise" was never
  true.
- **Workaround in this branch:** the key is always supplied from `ops/.env`.

### D-7. Abandoned migrations 0054–0056 run on every fresh database — Fixed
- **What:** HANDOVER says 0054–56 were abandoned PRs "no database ever ran",
  and ADR-0005 reserves those numbers for settlement v2. Yet the files sit in
  `db/migrations/`, and `migrate.ts` applies every `*.sql` there.
- **Why it fails:** 0054 creates a view over `settlement_batch_events`, which
  no migration creates. 0055 inserts `chart_of_accounts` columns (`code`,
  `account_type`, `description`) that migration 0007 never defined.
- **Breaks:** migrate stops at 0054 on a fresh database, so the stack can't
  be installed. 0054 also defines `merchant_payable_position` as the sum of
  *truncated scheme export lines*. The console's "Rebuild cached balances"
  (`ledger/refresh.go`) reads that view instead of the ledger, which is
  FP-203 (Alpha Retail 135K → 7K). The handover says the balance cache must
  only ever be rebuilt from the ledger.
- **Fix:** moved to `db/migrations/abandoned/` (not executed). The console
  rebuild now uses the ledger: see FP-203.

### D-8. No way to log in on a production deployment — Fixed (demo flag)
- **What:** with `NODE_ENV=production`, `sendOtpCode` logs that an OTP was
  generated but never the code, and no email or SMS provider exists.
- **Breaks:** password+OTP login (ARCHITECTURE §Security) can't be completed
  by anyone on the hosted box.
- **Fix:** `OTP_DEV_EXPOSE=true` in the demo's `ops/.env`; both login pages
  already display `devOtpCode`. Demo only: a real deployment needs an OTP
  delivery provider.

### D-9. Frontends can't reach the API when hosted — Fixed
- **What:** apps/web and apps/admin default to `http://localhost:3000` and use
  cookie auth with `credentials: "include"`; apps/api registers no CORS
  handling (MK's comment "CORS is locked to the two origins in config" refers
  to config that doesn't exist).
- **Breaks:** in any hosted setup, browsers block every API call, so the
  dashboard and console are unusable.
- **Fix:** one origin. nginx serves `/` (web) and `/admin/` (admin) and
  proxies `/v1` to the api; the bundles are built with relative API URLs.
  The admin router gets `basename` from Vite's `BASE_URL`.

### D-10. Node 20 silently runs zero tests and can't run the API — Fixed (images)
- **What:** `cookie@2.0.1` (via `@fastify/cookie`) requires Node ≥ 22.
  `tsx --test "src/**/*.test.ts"` relies on glob support that Node 20's test
  runner lacks: it prints "Could not find …" and runs nothing for
  api/reporting/web.
- **Breaks:** `npm test` "fails" without running a single API test on Node
  20, so every "tests pass" claim made on Node 20 is meaningless.
- **Fix:** images use `node:22-slim`. On Node 22 against a clean database,
  after the refund work: api 370/371 (the one failure is the flaky T-1),
  reporting 11/11, Go all packages including the DB-backed ones (which had
  been silently skipped because no `DATABASE_URL` was set).

---

## Refunds (FP-212 / FP-300) — the missing feature

`POST /v1/refunds` was a 501 stub. The "complete, tested" helpers behind it
(ONBOARDING) had a bug in almost every layer. Verified end to end on the
running stack: API → ledger → timeline → webhook → reporting → settlement
batch → reconciliation. Regression tests are in
`apps/api/src/refunds/refunds.fixes.test.ts` and
`apps/settlement/internal/settlement/batch_refund_test.go`.

### R-1. Every refund without a reason failed — Fixed
- **What:** migration 0070 adds `CHECK (reason IS NOT NULL)` with a default
  of `'unspecified'`; `processRefund` inserted `input.reason ?? null`.
- **Why:** an explicit NULL bypasses a column DEFAULT, so the CHECK fires.
- **Breaks:** in the old three-step flow, the insert failed *after* the acquirer
  had already refunded the card. The money left, and there was no refund row,
  ledger entry or webhook. 11 existing refund tests failed on it.
- **Fix:** `processRefund.ts` inserts `reason ?? 'unspecified'`.

### R-2. You could refund more than was charged — Fixed
- **What:** the refundable ceiling was `amount_fils - refunded_fils` (the
  *authorized* amount).
- **Breaks:** authorize 10.000 BD, capture 4.000 BD, refund 10.000 BD: 6.000 BD
  that was never charged goes to the cardholder ("can you refund more than
  what was actually charged?").
- **Fix:** ceiling is `captured_fils - refunded_fils` (`processRefund.ts`).

### R-3. FP-209 — concurrent refunds both succeed (double money out) — Fixed
- **What:** `processRefund` ran as three transactions (validate, acquirer,
  journal) with no row lock.
- **Why:** two requests with different idempotency keys both read
  `refunded_fils = 0`, both passed validation and both called the acquirer.
  Capture never had this because it holds `SELECT … FOR UPDATE` across the
  acquirer call ("held across the call on purpose" — YA).
- **Breaks:** each concurrent request refunds again, so money goes out twice.
- **Fix:** one transaction holding the row lock across the acquirer call, like
  capture. The second request waits, re-validates and gets 409. The test
  proves the acquirer is called exactly once.

### R-4. Any merchant could refund any other merchant's transaction — Fixed
- **What:** `initiateMerchantRefund` and `processRefund` looked transactions up
  `WHERE id = $1` only, then used the row's own `merchant_id`.
- **Breaks:** a merchant with a transaction id from another shop (receipts,
  links, logs) could send that shop's money back to the card. The TODO
  "another merchant's transaction answers 404 — Claude says it's covered"
  was never covered.
- **Fix:** `WHERE id = $1 AND merchant_id = $2` in both; the response is 404.

### R-5. Partial refunds don't sum back to the fee — Fixed
- **What:** each partial refund's fee reversal was rounded on its own
  (`calculateRefundFee(captured, fee, thisRefund)`). HANDOVER says it "sums
  back to the original fee across partials". It doesn't: fee 25 refunded in
  333 + 333 + 334 reverses 8 + 8 + 8 = 24.
- **Breaks:** the merchant is short a few fils on every split refund; the fee
  revenue account never returns to zero for a fully refunded transaction.
- **Fix:** reverse the *cumulative* share for everything refunded so far, minus
  what earlier refunds already reversed. A full refund reverses exactly the fee.
  `packages/money` is unchanged.

### R-6. Discounted merchants got back more fee than they paid — Fixed
- **What:** the "fee charged" read summed only `platform_fee_revenue` credits.
  The negotiated discount is a separate *debit* on that account
  (`discountAdjustment.ts`).
- **Breaks:** fee 250 with a 20 % discount (net 200) reversed 250, so the
  platform pays the merchant 50 fils per refund that it never earned.
- **Fix:** net of debits, excluding the refund flow's own reversal legs.

### R-7. Route was a 501 stub, and the drafted handler was unsafe — Fixed
- **What:** `/v1/refunds` returned 501. RefundDrawer posts to
  `/v1/merchants/:id/refunds`, which wasn't registered. The handler drafted in
  the comments made a fresh `randomUUID()` idempotency key per request (a retry
  after a timeout refunds twice) and spread the raw body into the call (a body
  `merchantId` could override the authenticated one).
- **Fix:** both paths registered. Idempotency-Key comes from the client header,
  only whitelisted body fields are read, `owner`/`finance` role is required,
  and the path merchant is scope-checked (403). The old 501 test said
  "delete/replace this when FP-212 lands", so it now asserts the live route.

### R-8. Shops never got a refund webhook — Fixed
- **What:** `refund.succeeded` wasn't in the dispatcher's eligible list and had
  no `buildEnvelope` case. Adding only the list entry (as the comment
  suggested) would throw in Step A and stall the whole webhook queue.
- **Fix:** public envelope (`refundId, transactionId, merchantId, amountFils,
  feeReversedFils, refundedTotalFils, transactionStatus`) and the list entry.

### R-9. FP-240 — merchants can't verify webhook signatures — Fixed
- **What:** the signature covers `canonicalJson(payload)` (sorted keys), but the
  dispatcher sent `JSON.stringify(payload)` in Postgres jsonb's key order, and
  "send test event" sent insertion order.
- **Why:** a receiver verifies HMAC over the raw bytes it received, which were
  not the bytes that were signed. Our own test only passed because it
  re-parsed and re-canonicalised the body.
- **Breaks:** every merchant doing standard raw-body verification rejects
  every webhook, including the first "test" ping.
- **Fix:** send exactly the canonical string that was signed (`dispatcher.ts`,
  `testSend.ts`). The test verifies HMAC over the raw body.
- (YA's `ya/sign-raw` branch was this fix; it was deleted from the remote.)

### R-10. Refunds never reached reporting — Fixed
- **What:** the consumer didn't select `refund.succeeded`, `applyEvent` had no
  case for it, the rollup wrote `refund_count`/`refund_gross_fils` columns that
  no migration created, and it bucketed by UTC date.
- **Breaks:** wiring only the event (as the comment suggested) would have
  thrown on the missing columns and stalled the reporting consumer for every
  merchant.
- **Fix:** migration 0073 adds the columns; the consumer and `applyEvent` handle
  the event; the rollup uses the Bahrain business day.

### R-11. Settlement paid out refunded money — Fixed
- **What:** `CloseBatch` (Go) never read `refunds`; batches had no refund columns.
- **Breaks:** after a refund the merchant was still paid the full capture net,
  so the platform funded every refund and `merchant_payable` went negative.
- **Fix:** `CloseBatch` claims unbatched refunds (oldest first) and sets
  `net = gross - fee - refunded + fee_reversed`, recorded on the batch
  (migration 0073) and in the `batch_closed` event. A refund that would make a
  batch negative waits for the next batch, so no negative payout is ever sent.
  The API and dashboard show the refund lines on each batch.

### R-12. Reconciliation showed every pending refund as a gap — Fixed
- **What:** the doc comment says refunds are "included … in pending", but
  nothing selected them.
- **Fix:** unbatched refunds (net of fee reversed) are subtracted from pending.
  Verified: refunds add 0 to the gap.

### R-13. The refund summary view was always empty — Fixed
- **What:** 0072 joined `t.id = r.id` (refund id = transaction id), and summed
  `captured_fils` once per partial refund.
- **Fix:** migration 0073 recreates it joined on `r.transaction_id`, with
  per-transaction aggregation.

### R-14. Refund events crash the dashboard — Fixed
- **What:** `bhd()` calls `toFils()` without `allowNegative`; refund timeline
  amounts are negative by design (0044). MK: "amounts are never negative in the
  dashboard. ignore".
- **Breaks:** the transaction page throws for every refunded transaction.
- **Fix:** `bhd()` formats signed amounts.

### R-15. No refund button, and the parked one was wrong — Fixed
- **What:** RefundDrawer was commented out and imported nowhere. It hid itself
  on `partially_refunded`, capped the amount at `capturedFils` ignoring earlier
  refunds, and made a new idempotency key per click. The API never returned
  `refundedFils` (the code comment "refundedFils is there" was false).
- **Fix:** drawer restored and rendered; refundable = captured − refunded; one
  key per opened form; `refundedFils` added to the transaction DTO.

### R-16. MDR recalculation erased a batch's refunds — Fixed
- **What:** `RecalculateMDR` rewrote `net = gross - newFee`.
- **Fix:** `net = oldNet - feeDiff`. It's identical for batches without
  refunds and keeps the refund deduction for batches with them.

### R-17. Net payout computed in float32 — Fixed
- **What:** `NetPayableFils` did `float32(gross)/1000 - float32(fee)/1000`.
  `.cursorrules` calls this intentional; ADR-0001 calls float on money a review
  blocker.
- **Breaks:** float32 has 24 bits of precision, so any batch above ~16,777 BD
  is paid out to the wrong fils.
- **Fix:** integer `gross - fee`.

---

## Balances

### FP-203. "Recalculate cached balances" wipes merchant balances — Fixed
- **What:** the console button (`ledger/refresh.go`) rebuilt
  `merchant_balances` from `merchant_payable_position`: the sum of *truncated
  scheme export lines* of closed batches. The CLI uses the ledger.
- **Why:** ADR-0004 chose "settled data" for speed. That isn't what a merchant
  is owed: it ignores fees, unbatched captures, refunds and adjustments, and
  truncates every line. HANDOVER: "there shouldn't be one that reads anything
  else"; CHANGELOG 1.7.0: "same rebuild as the CLI".
- **Breaks:** Alpha Retail 135K → 7K after one click; support then "fixes" it
  with cache-only adjustments.
- **Fix:** `RefreshBalanceCache` runs the ledger rebuild (`RebuildAllBalances`).
  The two refresh tests' fixture now posts the ledger legs a closed batch
  always has (the expected numbers are unchanged), and a new test proves
  console == CLI == ledger.

---

## Found while testing — Open

- **F-1. Payment-link checkout skips the negotiated discount.** The discount is
  applied by the capture *route* after `captureTransaction` returns; the
  checkout calls `captureTransaction` directly, so discounted merchants are
  overcharged on every payment-link sale.
- **F-2. Reconciliation estimates fees at a different rate than capture.** A
  4.000 capture for Alpha Retail shows a 10-fil gap immediately
  (`estimateFeeFils` vs the fee capture actually posted). Likely the same
  root as "dashboard shows 245bps, charged 225bps".
- **F-3. Status after fully refunding a partial capture stays
  `partially_captured`.** This is by design in `refundState.ts`, which keeps
  the authorization headroom open (the refund ceiling now prevents any second
  refund). Huda's later rule says it should read "refunded"; finance needs
  to decide.
- **T-1. Flaky test:** `dispatcher.test.ts` asserts `backoffDelayMs(1)` is
  exactly 1000, but that function applies a random ±10 % jitter, so it fails
  most runs. It's a test bug, not a product bug.

## Observed, not yet analysed
- The settlement daemon re-runs `RunDailyBatch` for the previous day on every
  poll (every minute) instead of once per day, while logging "next check-in"
  24 h ahead. It's idempotent, so no money effect was observed, but it
  relates to the "daily close runs at 3am" report and needs a root cause.
