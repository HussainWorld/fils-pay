# Deploying FilsPay to Dilmune Cloud

Everything runs from one compose file, `ops/docker-compose.prod.yml`:
Postgres (private), api, settlement daemon, reporting worker, and an nginx
container that serves the merchant dashboard on **:80** and the admin console
on **:8081**, proxying `/v1` to the api (same origin, no CORS needed).

## 1. Get the code onto the box

```bash
git clone https://github.com/HussainWorld/fils-pay.git && cd fils-pay
git checkout manaf
```

(or `scp`/upload the folder; `node_modules` and `dist` are not needed)

## 2. Secrets

```bash
cp ops/prod.env.example ops/.env.prod
# fill it in:
#   POSTGRES_PASSWORD / SETTLEMENT_INTERNAL_TOKEN : openssl rand -hex 24
#   WEBHOOK_SECRET_ENCRYPTION_KEY                 : openssl rand -base64 32
#   ACQUIRER_CALLBACK_SIGNING_SECRET              : from the acquirer (NOT the one in ops/.env.docker)
#   COOKIE_SECURE=false only if you serve plain http (no TLS) for the demo
```

`ops/.env.prod` is git-ignored. Compose refuses to start if any secret is missing.

## 3. Start

```bash
docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod up -d --build
# optional demo data (merchants, API keys printed in the output):
docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod --profile seed run --rm seed
```

The box has a 2 GB disk: if the first build runs out of space, run
`docker builder prune -af` and build again (images use slim bases now).

## 4. Check it is live

```bash
curl http://<host>/healthz            # {"status":"ok"}
curl http://<host>/readyz             # {"status":"ready"}
```

- Merchant dashboard: `http://<host>/`
- Admin console: `http://<host>:8081/`

## 5. Refund smoke test (FP-300) with a seeded API key

```bash
KEY=fp_live_...    # from the seed output
TX=$(curl -s http://<host>/v1/transactions -H "authorization: Bearer $KEY" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"amountFils":25000,"card":{"pan":"4242424242424242","expiryMonth":12,"expiryYear":2030,"cvv":"123"}}' | jq -r .id)
curl -s http://<host>/v1/transactions/$TX/capture -H "authorization: Bearer $KEY" -H "idempotency-key: $(uuidgen)" -H 'content-type: application/json' -d '{}'
curl -s http://<host>/v1/refunds -H "authorization: Bearer $KEY" -H "idempotency-key: $(uuidgen)" \
  -H 'content-type: application/json' -d "{\"transactionId\":\"$TX\",\"amountFils\":10000}"
curl -s http://<host>/v1/transactions/$TX/events -H "authorization: Bearer $KEY"
```

## What is different from the dev compose file (and why)

| Dev `docker-compose.yml` | Prod |
|---|---|
| Postgres published on `5432` with a password committed to git | not published at all |
| secrets hard-coded / in `ops/.env.docker` (committed) | `ops/.env.prod`, git-ignored, required |
| no web/admin | nginx serves both, proxies `/v1` |
| `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` default false | true |
| `node:20` (~1 GB bigger) | `node:20-slim` |
