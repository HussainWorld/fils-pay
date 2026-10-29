# FilsPay audit: what was wrong, why, and what we changed

Every fix is the smallest change that makes the behaviour right, has a
`FIX:` comment at the change explaining the cause, and has a regression test
that **fails on the old code and passes on the new** (`*.fix.test.ts`,
`*_test.go` files added next to the code). Test status after the work:
TS 466/466, Go all packages (`go test -p 1 ./...`), `npm run typecheck` clean.
Baseline before: 16 failing TS tests.

> Note on the AI config files: `CLAUDE.md`, `AGENTS.md` and `.cursorrules`
> contradict the ADRs (they say money is "cents", settlement is UTC midnight,
> `Math.random` is fine for OTPs, tests and `packages/money` must never be
> touched). We followed the ADRs and ARCHITECTURE. Where an existing test
> asserted the buggy behaviour, we corrected the test and said so in it.

## Money

| # | Symptom | Root cause | Fix | Where |
|---|---|---|---|---|
| 1 | CSV 4.755 BD imported as 0.475 | `parseDecimalMinor(raw)` defaults to **2** decimals: "4.755" → "4"+"75" = 475 fils | use `parseBhdToFils` (ADR-0001 rule 3) | `admin/adjustmentCsvParsing.ts` |
| 2 | Scheme file always a few fils **over** | file `amount` = untruncated gross as float, then `NUMERIC(10,2)` **rounds**; rounding ≥ truncation | write the truncated integer formatted to 2dp (ADR-0002) | `settlement/batch.go` |
| 3 | (found) payout loses fils on big batches | `NetPayableFils` subtracted in `float32` (7 digits) | integer `gross - fee` | `settlement/payable.go` |
| 4 | Split payouts short by tens of fils | each child `ApplyRateFils(net, w)` rounded alone | floor + largest remainder, sum == net | `splits/shares.go`, `allocate.go` |
| 5 | March sweep ran twice, gap doubled | random `entry_group_id` per run, no guard; also UTC month (misses Bahrain 1 Mar 00–03h) and debited `merchant_payable` | advisory lock + "already applied" check; Bahrain month; ADR-0002 accounts | `scripts/reconcile_march.ts` |
| 6 | Rebuild button: 135K → 7K | button read `merchant_payable_position` = sum of exported scheme lines, not the ledger | call the CLI's ledger rebuild | `internalapi/server.go` |
| 7 | MDR recalc changed paid batches | `status <> 'open'` includes `paid` | `status = 'closed'` | `recalculate_mdr.go` |
| 8 | Screen 245 bps, charged 225 | display ordered by `created_at` (backdated row wins) | `effective_from <= now()` like billing; Go ties by `created_at` too | `fees/currentFeeScheduleDisplay.ts`, `fee_schedule.go` |
| 9 | Lifetime estimate drifts | `REAL` column + `float32` | `BIGINT`, recomputed from paid batches | migration 0073, `payout_estimate.go` |
| 10 | (found) volume counter overflow | `INTEGER`/`int32`, wraps ~147K BD after the 2M BD tier | `BIGINT`/`int64` | migration 0074, `platform_volume.go` |
| 11 | (found) settlement summary 38% high | summed `t.captured_fils` (running total) once per capture event | sum `te.amount_fils`; index | `settlement/query.ts`, migration 0077 |
| 12 | (found) capture fee ≠ settlement fee | capture ignored the negotiated discount; a later separate adjustment ran only on one route | capture uses the settlement formula | `payments/capture.ts` |

⚠ The 0.15% platform volume discount has no finance sign-off on record (code
comments). Not removed (business decision); flagged.

## Security

| # | Issue | Root cause | Fix |
|---|---|---|---|
| 13 | Login works without OTP | `lookupSession` never checked `authenticated = true` | add the predicate (admin side had it) |
| 14 | OTP brute force | check-then-increment attempts: parallel guesses unlimited | atomic `UPDATE … WHERE attempt_count < max` (merchant + admin) |
| 15 | OTP predictable | `Math.random` | `crypto.randomInt` |
| 16 | Login lands in another merchant | OTP recipient looked up by email across all merchants | session bound to the password-checked user |
| 17 | Merchant A cancels B's link (IDOR) | UPDATE by link id only | scope by `merchant_id` |
| 18 | FP-187 expired link paid | expiry checked against client `submittedAt` | server time |
| 19 | 05-14 link charged twice | reservation committed + lock dropped; timeout takeover | claim→capture→finalize in one locked transaction |
| 20 | FP-209 concurrent refunds | validate / acquirer / journal in 3 steps, no lock | one transaction with `FOR UPDATE` like capture; refundable = captured (not authorized); scoped to merchant |
| 21 | FP-240 signatures | signed sorted JSON, sent unsorted; inbound: unsigned accepted, non-constant-time compare, re-serialized body | send the signed bytes; reject unsigned; `timingSafeEqual`; verify raw body |
| 22 | FP-201 duplicate callback notes | no dedupe at all | unique `callback_id` + `ON CONFLICT DO NOTHING` (0075) |
| 23 | Admin role checks | credit 2-person check by display name; impersonation gave owner/finance rights | compare admin id; impersonation = read-only support |
| 24 | (found) capture/void without role check | any merchant actor incl. read-only impersonation | owner/finance or API key |
| 25 | Key rotation | old key never revoked | revoke in the same transaction |
| 26 | (found) SSRF via webhooks | https-only was the only check; redirects followed | public hosts only in prod; `redirect: "manual"` |
| 27 | Large uploads/exports | export built in memory (OOM 512 MB) and pager dropped rows; PNG pixel bombs | keyset-paged stream; `limitInputPixels`; multipart part limits |

## Operations

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 28 | Close at 3am, not midnight | "today" taken from the UTC date | Bahrain date first (`BusinessDateAt`) |
| 29 | Test merchants in real settlement | "Recompute statuses" set `test_mode = false` | removed the side effect; chargebacks no longer reset |
| 30 | 08-21 duplicate payout notifications | NOT EXISTS then INSERT across processes | atomic `paid_notified_at` claim (0076) |
| 31 | (found) duplicate **payouts** | disbursement recorded per webhook delivery | one disbursement per batch (advisory lock + guard) |
| 32 | (found) reporting stops forever | parity check crashed on a missing rollup row | treat as 0 |
| 33 | (found) reconciliation gaps | payout legs counted as activity; pending fee used stale flat rate | exclude payout legs; use fee recorded at capture |

## FP-300: refunds, end to end

The unfinished feature was refunds (`POST /v1/refunds` returned 501, drawer
parked, `refund.succeeded` not delivered, nothing in settlement or reports).

- **API**: `POST /v1/refunds` and `POST /v1/merchants/:id/refunds`; Idempotency-Key required; owner/finance or API key; integer fils validation.
- **Ledger**: reversal legs; fee reversed **cumulatively** so partials sum to the exact fee.
- **Fees & payouts**: `CloseBatch` nets unbatched refunds out of the payout (never negative, carries forward).
- **Webhook**: `refund.succeeded` envelope, signed over the sent bytes.
- **Timeline / reports / reconciliation**: refund events (negative amounts render), reporting rollup by Bahrain day (0078), refund summary view fixed, reconciliation counts pending refunds.
- **Dashboard**: RefundDrawer wired (stable idempotency key per attempt).
- **Tests**: `routes/refunds.fp300.test.ts`, `settlement/refund_batch_test.go`, `reporting/.../refundRollup.fp300.test.ts`.
- **Deploy**: `ops/docker-compose.prod.yml` + `ops/DEPLOY.md`.

## Deployment and other additions

Hosting on Dilmune Cloud surfaced ten more problems (missing Dockerfiles, an
env file compose never loaded, Postgres published to the internet with the dev
password, an inverted DB-URL precedence, no way to log in in production, no
CORS, Node 20 running zero tests), plus R-16 (MDR recalculation erased
refund deductions). See **[FINDINGS.md](../FINDINGS.md)**.

## Still open (not fixed, flagged)

- The acquirer secret that was committed in `ops/.env.docker` is removed from the file (FINDINGS D-3), but it is still in git history: rotate it with the acquirer.
- Seed data contains an orphan ledger entry for Delta Wholesale (Sept) that reconciliation correctly flags.
- Go tests share one database across packages: run `go test -p 1 ./...`.
