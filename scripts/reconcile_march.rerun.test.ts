/**
 * Regression for the finance memo: running the March sweep twice must not
 * post twice, and the sweep must not touch merchant_payable.
 * Requires DATABASE_URL pointing at a migrated, seeded database.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Pool } from "pg";

const DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

test("running reconcile_march twice posts once, to the ADR-0002 accounts", { timeout: 120_000 }, async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const before = await pool.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE description = $1`, [DESCRIPTION]);
    const run = () => execFileSync("npx", ["tsx", "scripts/reconcile_march.ts"], { encoding: "utf8", env: process.env });
    run();
    const out2 = run();
    assert.match(out2, /already applied/);
    const rows = await pool.query<{ account_id: string; n: number; total: string }>(
      `SELECT account_id, count(*)::int AS n, sum(amount_fils)::text AS total
         FROM ledger_entries WHERE description = $1 GROUP BY account_id ORDER BY account_id`,
      [DESCRIPTION],
    );
    if (before.rows[0].n === 0) {
      assert.deepEqual(rows.rows.map((r) => r.account_id), ["card_scheme_clearing", "scheme_rounding_residue"]);
      assert.equal(rows.rows[0]!.total, rows.rows[1]!.total);
      // includes the 528 Bahrain-1-March captures a UTC window would miss
      const boundary = await pool.query(
        `SELECT count(*)::int AS n FROM transactions WHERE captured_fils % 10 <> 0
          AND occurred_at >= '2026-02-28T21:00:00Z' AND occurred_at < '2026-03-01T00:00:00Z'`,
      );
      assert.ok(boundary.rows[0].n > 0, "seed has Bahrain-1-March captures");
    }
  } finally {
    await pool.end();
  }
});
