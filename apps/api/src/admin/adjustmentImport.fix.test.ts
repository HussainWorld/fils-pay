/**
 * FIX A-1 regression: the same finance adjustment sheet cannot be applied
 * twice. Requires DATABASE_URL (migrated, incl. 0079).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { adjustmentImportFingerprint, applyAdjustmentImport } from "./adjustmentImport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("adjustmentImport.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
after(() => pool.end());

async function admin(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'x', 'A-1 test', 'finance') RETURNING id`,
    [`a1-${randomUUID()}@admin.test`],
  );
  return r.rows[0]!.id;
}

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ($1, 250, 'active', false) RETURNING id`,
    [`a1-merchant-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

async function postedFor(merchantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0) AS n
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  return Number(r.rows[0]!.n);
}

test("A-1: re-applying an identical sheet is refused with 409 and posts nothing", async () => {
  const adminUserId = await admin();
  const m = await merchant();
  const rows = [{ merchantId: m, amount: "4.750", reason: "September correction" }];

  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "sept.csv", rows });
  await assert.rejects(
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "sept (1).csv", rows }),
    (err: { statusCode?: number; code?: string }) =>
      err.statusCode === 409 && err.code === "adjustment_import_already_applied",
  );
  assert.equal(await postedFor(m), 4_750, "the adjustment must be posted exactly once");
});

test("A-1: two identical uploads racing each other apply once", async () => {
  const adminUserId = await admin();
  const m = await merchant();
  const rows = [{ merchantId: m, amount: "1.250" }];
  const results = await Promise.allSettled([
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "a.csv", rows }),
    applyAdjustmentImport(pool, { adminUserId, originalFilename: "b.csv", rows }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(await postedFor(m), 1_250);
});

test("A-1: a sheet with different content is still applied", async () => {
  const adminUserId = await admin();
  const m = await merchant();
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "x.csv", rows: [{ merchantId: m, amount: "1.000" }] });
  await applyAdjustmentImport(pool, { adminUserId, originalFilename: "x.csv", rows: [{ merchantId: m, amount: "2.000" }] });
  assert.equal(await postedFor(m), 3_000);
});

test("A-1: the app fingerprint equals the migration's backfill formula over the stored rows", async () => {
  const adminUserId = await admin();
  const m = await merchant();
  const rows = [
    { merchantId: m, amount: "0.500", reason: "a" },
    { merchantId: m, amount: "-0.250" },
  ];
  const { importId } = await applyAdjustmentImport(pool, { adminUserId, originalFilename: "f.csv", rows });
  const r = await pool.query<{ stored: string; recomputed: string }>(
    `SELECT ai.content_sha256 AS stored,
            (SELECT encode(digest(string_agg(r.merchant_id::text || E'\\t' || r.raw_amount_text || E'\\t' || COALESCE(r.reason, ''),
                                             E'\\n' ORDER BY r.row_number), 'sha256'), 'hex')
               FROM adjustment_import_rows r WHERE r.adjustment_import_id = ai.id) AS recomputed
       FROM adjustment_imports ai WHERE ai.id = $1`,
    [importId],
  );
  assert.equal(r.rows[0]!.stored, adjustmentImportFingerprint(rows));
  assert.equal(r.rows[0]!.recomputed, r.rows[0]!.stored);
});
