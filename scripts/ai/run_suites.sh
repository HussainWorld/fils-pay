#!/usr/bin/env bash
# Run each DB-backed suite against its own freshly migrated database.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-$(mktemp -d)}
echo "logs in $OUT"
PW=$(grep '^POSTGRES_PASSWORD=' "$ROOT/ops/.env" | cut -d= -f2-)
url() { echo "postgres://filspay:${PW}@127.0.0.1:5432/$1?sslmode=disable"; }
fresh() {
  docker exec ops-postgres-1 psql -q -U filspay -d postgres -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" -c "CREATE DATABASE $1" >/dev/null
  (cd "$ROOT" && DATABASE_URL="$(url $1)" npx tsx db/migrate.ts >/dev/null 2>&1) || echo "migrate $1 FAILED"
}
summ() { grep -E "^# (tests|pass|fail) " "$1" | tr '\n' ' '; echo; }

fresh rd_api
(cd "$ROOT/apps/api" && DATABASE_URL="$(url rd_api)" npx tsx --test --test-concurrency=1 $(find src -name '*.test.ts' | sort) > "$OUT/t-api.log" 2>&1); echo -n "api exit=$? "; summ "$OUT/t-api.log"

fresh rd_rep
(cd "$ROOT/apps/reporting" && DATABASE_URL="$(url rd_rep)" npx tsx --test --test-concurrency=1 $(find src -name '*.test.ts' | sort) > "$OUT/t-reporting.log" 2>&1); echo -n "reporting exit=$? "; summ "$OUT/t-reporting.log"

fresh rd_scr
(cd "$ROOT" && SEED_ALLOW_RESET=1 DATABASE_URL="$(url rd_scr)" npm run -s seed >/dev/null 2>&1) || echo "seed rd_scr FAILED"
(cd "$ROOT" && DATABASE_URL="$(url rd_scr)" npx tsx --test --test-concurrency=1 scripts/*.test.ts > "$OUT/t-scripts.log" 2>&1); echo -n "scripts exit=$? "; summ "$OUT/t-scripts.log"

fresh rd_go
(cd "$ROOT/apps/settlement" && DATABASE_URL="$(url rd_go)" go test -p 1 ./... > "$OUT/t-go.log" 2>&1); echo "go exit=$?"; grep -E "^(ok|FAIL|---)" "$OUT/t-go.log" | head -20
