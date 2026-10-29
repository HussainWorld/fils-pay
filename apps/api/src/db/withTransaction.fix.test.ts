/**
 * FIX T-2 regression: a failing ROLLBACK must not replace the original error,
 * and the dead client must be destroyed (release(err)), not returned to the pool.
 * No database needed: the pool and client are stand-ins.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./withTransaction.js";

function fakePool(opts: { rollbackFails: boolean }) {
  const released: unknown[] = [];
  const client = {
    async query(sql: string) {
      if (sql === "ROLLBACK" && opts.rollbackFails) throw new Error("Connection terminated unexpectedly");
      return { rows: [], rowCount: 0 };
    },
    release(err?: unknown) {
      released.push(err);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, released };
}

test("T-2: when ROLLBACK itself fails, the original error is rethrown and the client is destroyed", async () => {
  const { pool, released } = fakePool({ rollbackFails: true });
  await assert.rejects(
    withTransaction(pool, async () => {
      throw new Error("refund_exceeds_refundable");
    }),
    /refund_exceeds_refundable/,
  );
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error, "a client whose ROLLBACK failed must be released with an error");
});

test("T-2: a normal rollback still releases the client back to the pool", async () => {
  const { pool, released } = fakePool({ rollbackFails: false });
  await assert.rejects(
    withTransaction(pool, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(released, [undefined]);
});

test("T-2: a successful transaction returns the result and releases normally", async () => {
  const { pool, released } = fakePool({ rollbackFails: false });
  const value = await withTransaction(pool, async (client: PoolClient) => {
    await client.query("SELECT 1");
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(released, [undefined]);
});
