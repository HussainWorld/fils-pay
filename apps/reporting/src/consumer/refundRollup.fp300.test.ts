/** FP-300: refunds show up in the reporting read model, on the Bahrain business day. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";
import { toBahrainDateString } from "../bahrainDate.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
test.after(async () => {
  await pool.end();
});

test("refund.succeeded events roll up into merchant_daily_volume", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`refund rollup ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const txnId = randomUUID();
  await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: txnId,
    payload: { merchantId, amountCapturedFils: 10_000, feeFils: 248, newStatus: "captured", capturedTotalFils: 10_000 },
  });
  for (const amountFils of [3_333, 6_667]) {
    await enqueueEvent(pool, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: txnId,
      payload: { merchantId, refundId: randomUUID(), amountFils, feeReversedFils: 0, refundedTotalFils: 0, newStatus: "x" },
    });
  }
  for (;;) {
    const { processedCount } = await runConsumerPass(pool, { consumerBatchLimit: 500 });
    if (processedCount === 0) break;
  }
  const row = await pool.query<{ captured_gross_fils: string; refund_count: number; refund_gross_fils: string; volume_date: Date }>(
    `SELECT captured_gross_fils, refund_count, refund_gross_fils, volume_date::text AS volume_date
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(row.rowCount, 1, "capture and refunds land on the same business day row");
  assert.equal(Number(row.rows[0]!.captured_gross_fils), 10_000);
  assert.equal(row.rows[0]!.refund_count, 2);
  assert.equal(Number(row.rows[0]!.refund_gross_fils), 10_000);
  assert.equal(String(row.rows[0]!.volume_date), toBahrainDateString(new Date()));
});
