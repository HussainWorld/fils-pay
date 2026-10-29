/** One settlement batch must produce exactly one payout disbursement. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { recordPayoutDisbursementEffect } from "./payoutDisbursement.js";
import { closeAll, pool } from "../fixesTestSupport.js";

test.after(closeAll);

test("repeated / concurrent disbursement effects for one batch record one payout", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Disb fix ${randomUUID()}`],
  );
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
     VALUES ($1, current_date, 'paid', 9000, 0, 9000, now(), now()) RETURNING id`,
    [merchant.rows[0]!.id],
  );
  const batchId = batch.rows[0]!.id;
  // e.g. two webhook endpoints x duplicated settlement.paid event
  await Promise.all([1, 2, 3, 4].map(() => recordPayoutDisbursementEffect(pool, batchId, 9000)));
  const rows = await pool.query(`SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, [batchId]);
  assert.equal(rows.rowCount, 1);
});
