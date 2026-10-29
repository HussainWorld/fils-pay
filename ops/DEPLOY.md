# Deploying FilsPay to Dilmune Cloud

One compose file, `ops/docker-compose.yml`: Postgres (loopback only), api,
settlement daemon, reporting worker, and an nginx `proxy` that serves the
merchant dashboard at `/` and the admin console at `/admin/`, proxying `/v1`
to the api (same origin, no CORS). Only the proxy is published, on
`PUBLIC_PORT` (80 on the server). Dilmune's firewall opens 22/80/443 only.

Live demo: http://139.59.57.131 (Dilmune server `stormy-tiger`, Ubuntu 24.04,
2 GB RAM, 50 GB disk, user `dilmune`).

## 1. Server prerequisites (once)

```bash
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx
sudo usermod -aG docker "$USER"            # log in again afterwards
# 2 GB RAM: add swap so the image builds don't run out of memory
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

## 2. Code and secrets

```bash
git clone https://github.com/HussainWorld/fils-pay.git && cd fils-pay && git checkout dev
ops/gen-env.sh http://<public-host>       # writes the gitignored ops/.env with fresh secrets
sed -i 's/^PUBLIC_PORT=.*/PUBLIC_PORT=80/' ops/.env
```

`gen-env.sh` refuses to overwrite an existing `ops/.env`: the Postgres password
is baked into the data volume and the webhook key encrypts stored secrets.
`COOKIE_SECURE` follows the URL scheme; `OTP_DEV_EXPOSE=true` shows the login
OTP on screen because no email/SMS sender exists (demo only).

## 3. Deploy

```bash
ops/deploy.sh --seed     # first time: build, migrate, load demo data, start
ops/deploy.sh            # afterwards: build, migrate, restart (keeps data)
```

`--seed` truncates and regenerates the fixture tables. `deploy.sh` prunes the
build cache afterwards, and waits for `/readyz` through the proxy.

## 4. Check it

- `http://<host>/readyz` → `{"status":"ready"}`
- Dashboard: `http://<host>/` (`owner@alpharetail.example` / `FilsPaySeed!2026`)
- Admin: `http://<host>/admin/` (`superadmin@filspay.test` / `FilsPayAdminSeed!2026`)

## What differs from the original dev compose file (and why)

| Original | Now |
|---|---|
| Postgres on `0.0.0.0:5432` with a password committed to git | `127.0.0.1` only, random password |
| `.env.docker` never loaded; acquirer secret committed in it | `env_file`; secrets in gitignored `ops/.env` |
| settlement exits at boot (no internal token) | token generated and passed to api + settlement |
| no web/admin | nginx serves both under one origin |
| `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` default false | true |
| referenced Dockerfiles missing | `ops/Dockerfile.{node,go,web}` (Node 22) |

Details and reasons: FINDINGS.md D-1…D-10.
