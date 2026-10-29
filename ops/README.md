# ops/

Local development stack for FilsPay: Postgres plus the three services that
talk to it directly (apps/api, apps/settlement, apps/reporting). The hosted
demo instance uses the same compose file with a different `.env`.

## Quick start (local or hosted box)

Needs Docker with the compose plugin, `openssl` and `curl`. From the repo root:

```
ops/gen-env.sh https://<public-host>   # once per host; writes ops/.env with fresh secrets
ops/deploy.sh --seed                   # first deploy: build, migrate, seed, start
ops/deploy.sh                          # later deploys: build, migrate, restart (keeps data)
```

Then open `<public-url>/` for the merchant dashboard and hosted checkout
and `<public-url>/admin/` for the ops console. Locally that's
`http://localhost:8080`.

Seed logins: merchant `owner@alpharetail.example` / `FilsPaySeed!2026`,
admin `superadmin@filspay.test` / `FilsPayAdminSeed!2026`. With
`OTP_DEV_EXPOSE=true` (gen-env's default, since no email provider is wired
up) the login page shows the OTP code.

`--seed` truncates and regenerates the fixture tables. Don't run it
against data you want to keep.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack; only `proxy` is published (`PUBLIC_PORT`, default 8080) |
| `.env.docker` | shared non-secret api settings (committed) |
| `.env` | per-host secrets and URLs (gitignored, from `gen-env.sh`) |
| `Dockerfile.node` | image for api, reporting, migrate and seed (`node:22-slim`; cookie@2 needs Node 22) |
| `Dockerfile.go` | multi-stage build of `apps/settlement` to a static binary on alpine |
| `Dockerfile.web` | builds apps/web + apps/admin, serves them from nginx |
| `nginx.conf` | `/` → web, `/admin/` → admin, `/v1/*` + `/healthz` + `/readyz` → api |
| `gen-env.sh` / `deploy.sh` | secrets bootstrap / build-migrate-start |

The frontends and the API share one origin through nginx. apps/api has no
CORS handling and both frontends authenticate with cookies, so serving
them from separate origins doesn't work.

If the public URL is plain http, keep `COOKIE_SECURE=false`; browsers drop
Secure cookies over http. `gen-env.sh` sets it from the URL scheme.

## Database

Every service, plus the one-off `migrate`/`seed` jobs, connects with the
same `filspay` role and the same `DATABASE_URL`
(`postgres://filspay:${POSTGRES_PASSWORD}@postgres:5432/filspay?sslmode=disable`,
password from `ops/.env`). Postgres is published on 127.0.0.1 only.
One role keeps local setup to a single password instead of hand-rolling
per-service grants for a stack this size. `sslmode=disable` is safe here:
Postgres and every service run on the same Docker Compose bridge network,
which never carries traffic outside the host, so there's no untrusted hop
for a connection to cross.

The settlement worker can be given a second connection string,
`PGCONN_SETTLEMENT`, for its batch-close pool. It only takes effect when
`DATABASE_URL` is unset.

To reset the database to a clean, freshly-seeded state at any point, re-run
the `seed` job above — `db/seed/index.ts` truncates and regenerates its
fixture tables on every invocation; it doesn't need the volume removed
first.

## Required settings per service

| Service | Needs | Where it comes from in compose |
|---|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL` | `environment:` |
| api | `WEBHOOK_SECRET_ENCRYPTION_KEY` | only outside dev; a dev key is used otherwise |
| api | `ACQUIRER_CALLBACK_SIGNING_SECRET`, `NODE_ENV` | `.env.docker` |
| settlement | `DATABASE_URL` | `environment:` |
| settlement | `SETTLEMENT_INTERNAL_TOKEN` | defaults to `dev-token` |
| reporting | `DATABASE_URL` | `environment:`; runs `worker` by default |

> **MK:** the api won't boot without WEBHOOK_SECRET_ENCRYPTION_KEY in any environment. set it on the hosted box.

## Resource sizing

The hosted demo box is 0.5 vCPU / 2 GB RAM / 2 GB disk; the API container is
limited to 512 MB. Postgres defaults are fine at this size. The settlement
image is built on the box with `go build` from `Dockerfile.go`.

> **AM:** first build on the box filled the disk (go build cache). cleared it and it went through on the second try
