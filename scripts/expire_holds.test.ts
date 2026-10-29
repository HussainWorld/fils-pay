/**
 * expire_holds against a real, migrated Postgres (DATABASE_URL).
 *
 * FIX H-1: these tests used to assert the text of the DELETE the script built
 * ("DELETE FROM holds WHERE id = ANY($1::uuid[])"), i.e. they locked in the
 * deletion itself, and never covered the empty-id night that turned it into
 * `DELETE FROM holds`. They now assert the behaviour the handover specifies:
 * expired active holds flip to 'expired', nothing is ever deleted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { expireHolds } from "./expire_holds.js";
import { buildDelete, buildWhere } from "./lib/sqlFilter.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("expire_holds.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(() => pool.end());

async function merchantWithHolds() {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Holds ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const hold = async (status: string, expiresIn: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO holds (merchant_id, amount_fils, status, expires_at)
         VALUES ($1, 1000, $2, now() + $3::interval) RETURNING id`,
        [merchantId, status, expiresIn],
      )
    ).rows[0]!.id;
  return {
    merchantId,
    expiredActive: await hold("active", "-1 hour"),
    liveActive: await hold("active", "1 day"),
    released: await hold("released", "-1 hour"),
  };
}

async function statuses(merchantId: string): Promise<Map<string, string>> {
  const r = await pool.query<{ id: string; status: string }>(`SELECT id, status FROM holds WHERE merchant_id = $1`, [
    merchantId,
  ]);
  return new Map(r.rows.map((row) => [row.id, row.status]));
}

test("an active hold past expires_at is marked expired; others are untouched; nothing is deleted", async () => {
  const h = await merchantWithHolds();
  await expireHolds(pool);
  const s = await statuses(h.merchantId);
  assert.equal(s.size, 3, "no hold may be deleted");
  assert.equal(s.get(h.expiredActive), "expired");
  assert.equal(s.get(h.liveActive), "active");
  assert.equal(s.get(h.released), "released");
});

test("a night with nothing to expire changes nothing (it used to delete every hold)", async () => {
  const h = await merchantWithHolds();
  await expireHolds(pool); // first run expires this merchant's one candidate (and any others)
  const before = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM holds`);
  const changed = await expireHolds(pool); // nothing left to expire
  const after = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM holds`);
  assert.equal(changed, 0);
  assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  assert.equal((await statuses(h.merchantId)).size, 3);
});

test("sqlFilter: an empty id list matches nothing, and an unscoped DELETE is refused", () => {
  assert.equal(buildWhere({ id: [] }).clause, "WHERE FALSE");
  assert.equal(buildDelete("holds", { id: [] }).text, "DELETE FROM holds WHERE FALSE");
  assert.throws(() => buildDelete("holds", {}), /without a WHERE clause/);
});
