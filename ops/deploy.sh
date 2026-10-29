#!/usr/bin/env bash
# Build and (re)start the FilsPay stack on this host.
#
# Usage: ops/deploy.sh [--seed]
#   --seed   also (re)load the demo seed data. TRUNCATES fixture tables —
#            use on first deploy only.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f ops/docker-compose.yml)

if [ ! -f ops/.env ]; then
  echo "deploy: ops/.env missing — run ops/gen-env.sh <public-url> first" >&2
  exit 1
fi

"${COMPOSE[@]}" build
# The Go/npm build cache is what filled the 2 GB disk last time.
docker builder prune -f >/dev/null

"${COMPOSE[@]}" up -d postgres
"${COMPOSE[@]}" run --rm migrate
if [ "${1:-}" = "--seed" ]; then
  "${COMPOSE[@]}" run --rm seed
fi
"${COMPOSE[@]}" up -d api settlement reporting proxy

"${COMPOSE[@]}" ps
echo
echo "deploy: waiting for the api through the proxy..."
PORT="$(grep -E '^PUBLIC_PORT=' ops/.env | cut -d= -f2)"
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT:-8080}/readyz" >/dev/null 2>&1; then
    echo "deploy: up — http://localhost:${PORT:-8080}/ (dashboard), /admin/ (console)"
    exit 0
  fi
  sleep 2
done
echo "deploy: api not ready after 60s — check: ${COMPOSE[*]} logs api" >&2
exit 1
