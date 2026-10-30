/**
 * Regression tests for checklist round 2, api side of reporting:
 * B76 (admin analytics rebuild coordinates the worker cursor, keeps refunds)
 * and B86 (saved-filter cap).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { APPROVED_CARD, app, closeAll, createApprovedMerchantWithApiKey, pool, signedInAdmin } from "./fixesTestSupport.js";
import { MAX_SAVED_FILTERS_PER_MERCHANT, createSavedFilter } from "./reporting/savedFilters.js";

test.after(closeAll);

test("B76: the admin rebuild moves the reporting cursor past what it counted, and keeps refunds", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("b76");
  const bearer = { authorization: `Bearer ${rawKey}` };
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...bearer, "idempotency-key": randomUUID() },
    payload: { amountFils: 10_000, card: APPROVED_CARD, reference: "b76" },
  });
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({ method: "POST", url: `/v1/transactions/${id}/capture`, headers: { ...bearer, "idempotency-key": randomUUID() }, payload: {} });
  assert.equal(cap.statusCode, 200, cap.body);
  const ref = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...bearer, "idempotency-key": randomUUID() },
    payload: { transactionId: id, amountFils: 2_500 },
  });
  assert.ok(ref.statusCode < 300, ref.body);
  const newest = await pool.query<{ id: string }>(`SELECT MAX(id) AS id FROM outbox_events`);

  const admin = await signedInAdmin("finance", "b76");
  const rebuild = await app.inject({ method: "POST", url: "/v1/admin/reporting/rebuild", headers: { cookie: admin.cookie } });
  assert.equal(rebuild.statusCode, 200, rebuild.body);

  // The worker will continue after the events the rebuild already counted
  // (old code left the cursor behind, so they were applied a second time).
  const cursor = await pool.query<{ last_processed_id: string }>(
    `SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = 'reporting'`,
  );
  assert.ok(BigInt(cursor.rows[0]!.last_processed_id) >= BigInt(newest.rows[0]!.id));

  const row = await pool.query<{ captured_count: number; refund_count: number; refund_gross_fils: string }>(
    `SELECT captured_count, refund_count, refund_gross_fils FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(row.rows[0]!.captured_count, 1);
  assert.equal(row.rows[0]!.refund_count, 1, "old code: TRUNCATE wiped refunds and never restored them");
  assert.equal(Number(row.rows[0]!.refund_gross_fils), 2_500);
});

test("B86: a merchant cannot save more than the documented 50 filters", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`b86 ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  for (let i = 0; i < MAX_SAVED_FILTERS_PER_MERCHANT; i++) {
    await createSavedFilter(pool, { merchantId, name: `f${i}`, filter: { status: "captured" } });
  }
  await assert.rejects(
    createSavedFilter(pool, { merchantId, name: "one too many", filter: {} }),
    (err: { statusCode?: number; code?: string }) => err.statusCode === 422 && err.code === "saved_filter_limit_reached",
  );
});
