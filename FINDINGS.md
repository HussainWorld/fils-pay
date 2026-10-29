# FilsPay audit — findings

Each entry: **what's wrong**, **why it happens**, **what it breaks**, and
the fix. Source of truth for "correct" behaviour is `docs/ARCHITECTURE.md`
and `docs/adr/` (per the briefing). Where `CLAUDE.md`, `AGENTS.md` or
`.cursorrules` contradict the ADRs, the ADRs win; see A-0.

Status: **Fixed** (in this branch) · **Open** (found, not fixed yet).

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
  rebuild now fails loudly instead of overwriting balances; the FP-203 fix
  (rebuild from the ledger, like the CLI) is still to do.

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
- **Fix:** images use `node:22-slim`. On Node 22 against a clean database:
  api 350/362 pass (the 11 refund failures are R-1), reporting 11/11.

---

## Refunds (FP-212 / FP-300) — found while testing

### R-1. Every refund without a reason fails — Open
- **What:** migration 0070 adds `CHECK (reason IS NOT NULL)` and a column
  default of `'unspecified'`. `processRefund` inserts `input.reason ?? null`.
  An explicit NULL bypasses the default and violates the check.
- **Breaks:** any refund request without a `reason` throws after the
  acquirer has already refunded the card, so the money goes back to the
  cardholder but nothing is recorded in the ledger. 11 refund tests fail on
  `chk_refunds_reason_not_null`.

---

## Observed, not yet analysed
- The settlement daemon re-runs `RunDailyBatch` for the previous day on every
  poll (every minute) instead of once per day, while logging "next check-in"
  24 h ahead. It's idempotent, so no money effect was observed, but it
  relates to the "daily close runs at 3am" report and needs a root cause.
