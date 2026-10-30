/**
 * B52: the seed TRUNCATEs every merchant-linked table, so it must refuse a
 * database that is not local unless explicitly marked disposable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDisposableDatabase } from "../db/seed/generate.js";

test("B52: the seed refuses a shared/staging database", () => {
  assert.throws(() => assertDisposableDatabase("postgres://u:p@staging-2.internal:5432/filspay", {}), /refusing to TRUNCATE/);
  assert.throws(() => assertDisposableDatabase("postgres://u:p@10.0.4.12/filspay", {}), /refusing/);
  assert.throws(() => assertDisposableDatabase(undefined, {}), /refusing/);
});

test("B52: local databases and explicitly disposable ones are allowed", () => {
  assert.doesNotThrow(() => assertDisposableDatabase("postgres://u:p@localhost:5432/filspay", {}));
  assert.doesNotThrow(() => assertDisposableDatabase("postgres://u:p@127.0.0.1/filspay", {}));
  assert.doesNotThrow(() => assertDisposableDatabase("postgres://u:p@[::1]:5432/filspay", {}));
  assert.doesNotThrow(() => assertDisposableDatabase("postgres://u:p@postgres:5432/filspay", { SEED_ALLOW_RESET: "1" }));
});
