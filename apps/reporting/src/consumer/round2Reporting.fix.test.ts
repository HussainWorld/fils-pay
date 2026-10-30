/**
 * Regression tests for checklist round 2, reporting consumer:
 * B74 (cursor lock across processes), B75 (late-committing events),
 * B78 (settlement.paid refreshes payout trends).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { runConsumerPass } from "./runConsumerPass.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const config = { consumerBatchLimit: 500 };
test.after(() => pool.end());

async function createMerchant(label: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`R2 reporting ${label} ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

function captured(merchantId: string, amount = 1_000) {
  return {
    eventType: "transaction.captured" as const,
    aggregateType: "transaction" as const,
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: amount, feeFils: 25, newStatus: "captured", capturedTotalFils: amount },
  };
}

async function drain(): Promise<void> {
  while ((await runConsumerPass(pool, config)).processedCount > 0);
}

async function capturedCount(merchantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(captured_count), 0) AS n FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  return Number(r.rows[0]!.n);
}

test("B74: two consumer passes running at once (worker + catch-up) apply an event once", async () => {
  await drain();
  const merchantId = await createMerchant("b74");
  await enqueueEvent(pool, captured(merchantId));

  // Pass 1 (the "worker") runs on its own pool and is paused mid-pass, so
  // pass 2 (the "catch-up" process) deterministically starts while pass 1
  // is still open — the cross-process overlap a `running` flag can't see.
  const slowPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const realConnect = slowPool.connect.bind(slowPool);
  (slowPool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    const client = await realConnect();
    const realQuery = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
    (client as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
      // Pause after pass 1 has read the cursor and the events but before it
      // writes anything (its cursor UPDATE would otherwise serialize pass 2).
      if (typeof args[0] === "string" && args[0].includes("INSERT INTO merchant_daily_volume")) {
        await new Promise((r) => setTimeout(r, 400));
      }
      return realQuery(...args);
    };
    return client;
  };
  try {
    await Promise.all([
      runConsumerPass(slowPool, config),
      new Promise((r) => setTimeout(r, 150)).then(() => runConsumerPass(pool, config)),
    ]);
  } finally {
    await slowPool.end();
  }
  assert.equal(await capturedCount(merchantId), 1, "old code: both passes applied it (2)");
});

test("B75: an event that commits after the watermark passed its id is still applied, once", async () => {
  await drain();
  const slowMerchant = await createMerchant("b75-slow");
  const fastMerchant = await createMerchant("b75-fast");

  const slow = await pool.connect();
  try {
    await slow.query("BEGIN");
    const lowId = await enqueueEvent(slow, captured(slowMerchant)); // id allocated, not committed
    const highId = await enqueueEvent(pool, captured(fastMerchant)); // committed
    assert.ok(highId.id > lowId.id);

    await runConsumerPass(pool, config); // watermark moves past the slow event's id
    await slow.query("COMMIT");
  } finally {
    slow.release();
  }

  await drain();
  assert.equal(await capturedCount(fastMerchant), 1);
  assert.equal(await capturedCount(slowMerchant), 1, "old code: the late event was skipped forever (0)");
  await drain(); // and the lookback never applies it a second time
  assert.equal(await capturedCount(slowMerchant), 1);
});

test("B78: settlement.paid updates the cached payout trend from 'closed' to 'paid'", async () => {
  await drain();
  const merchantId = await createMerchant("b78");
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
     VALUES ($1, '2026-03-01', 'closed', 5_000, 125, 4_875, now()) RETURNING id`,
    [merchantId],
  );
  const batchId = batch.rows[0]!.id;
  await enqueueEvent(pool, {
    eventType: "settlement.batch_closed",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-03-01", grossFils: 5_000, feeFils: 125, netPayoutFils: 4_875 },
  });
  await drain();

  await pool.query(`UPDATE settlement_batches SET status = 'paid', paid_at = now() WHERE id = $1`, [batchId]);
  await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, settlementBatchId: batchId, netPayoutFils: 4_875 },
  });
  await drain();

  const trend = await pool.query<{ status: string; paid_at: Date | null }>(
    `SELECT status, paid_at FROM merchant_payout_trends WHERE settlement_batch_id = $1`,
    [batchId],
  );
  assert.equal(trend.rows[0]!.status, "paid", "old code: stayed 'closed'");
  assert.ok(trend.rows[0]!.paid_at);
});
