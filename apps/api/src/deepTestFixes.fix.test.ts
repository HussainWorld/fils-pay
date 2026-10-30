/**
 * Regression tests for the bugs found by the live deep test (FINDINGS.md):
 * X-1, TZ-2, CR-1, FD-2, FP-203b, CP-1. Requires DATABASE_URL (migrated).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createCreditRequest } from "./admin/credits.js";
import { getMerchantDetailForAdmin, listMerchantsForAdmin } from "./admin/merchants.js";
import { getReconciliationReport } from "./settlement/query.js";
import {
  APPROVED_CARD,
  app,
  closeAll,
  createApprovedMerchantWithApiKey,
  pool,
  signedInAdmin,
} from "./fixesTestSupport.js";

after(closeAll);

const key = () => ({ "idempotency-key": randomUUID() });

async function onSchedule225(merchantId: string): Promise<void> {
  // merchants.mdr_bps stays 250 (the stale column); the contract moved to 225 bps.
  await pool.query(`INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 225, '2026-01-01T00:00:00+03')`, [
    merchantId,
  ]);
}

async function ledgerPayable(merchantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0) AS n
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  return Number(r.rows[0]!.n);
}

async function cachedPayable(merchantId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT cached_payable_fils AS n FROM merchant_balances WHERE merchant_id = $1`, [
    merchantId,
  ]);
  return Number(r.rows[0]?.n ?? 0);
}

test("X-1: export-summary requires a merchant credential and works with one", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("x1");
  const anon = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(anon.statusCode, 401, anon.body);
  const authed = await app.inject({ method: "GET", url: "/v1/reporting/export-summary", headers: { authorization: `Bearer ${rawKey}` } });
  assert.equal(authed.statusCode, 200, authed.body);
});

test("TZ-2: a payment-link expiry without a timezone is refused; with one it is accepted", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("tz2");
  const create = (expiresAt: string) =>
    app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { amountFils: 4_750, reference: "tz2", expiresAt },
    });
  const zoneless = await create("2099-12-31T23:59");
  assert.equal(zoneless.statusCode, 400, zoneless.body);
  const bahrain = await create("2099-12-31T23:59:00+03:00");
  assert.equal(bahrain.statusCode, 201, bahrain.body);
  assert.equal((bahrain.json() as { expiresAt: string }).expiresAt, "2099-12-31T20:59:00.000Z");
});

test("CR-1: a credit reverses the MDR at the contracted schedule rate, not the stale column", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("cr1");
  await onSchedule225(merchantId);
  const admin = await signedInAdmin("finance", "cr1");
  const credit = await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: { baseAmountFils: 10_000, reasonCode: "goodwill", effectiveDate: "2026-10-01", reverseFee: true },
  });
  assert.equal(credit.feeReversalFils, 225, "2.25% of 10.000 BD, not 2.50% (250)");
});

test("FD-2: the admin console shows the rate actually charged", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("fd2");
  await onSchedule225(merchantId);
  const detail = await getMerchantDetailForAdmin(pool, merchantId);
  assert.equal(detail?.merchant.mdrBps, 225);
  const list = await listMerchantsForAdmin(pool, { q: merchantId });
  assert.equal(list.merchants.find((m) => m.id === merchantId)?.mdrBps, 225);
});

test("FP-203b: captures and refunds keep the cached balance equal to the ledger", async () => {
  const { merchantId, rawKey } = await createApprovedMerchantWithApiKey("fp203b");
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, ...key() },
    payload: { amountFils: 20_000, card: APPROVED_CARD, reference: "fp203b" },
  });
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({ method: "POST", url: `/v1/transactions/${id}/capture`, headers: { authorization: `Bearer ${rawKey}`, ...key() }, payload: {} });
  assert.equal(cap.statusCode, 200, cap.body);
  assert.equal(await cachedPayable(merchantId), await ledgerPayable(merchantId), "after capture");

  const ref = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}`, ...key() },
    payload: { transactionId: id, amountFils: 5_000 },
  });
  assert.equal(ref.statusCode, 200, ref.body);
  assert.equal(await cachedPayable(merchantId), await ledgerPayable(merchantId), "after refund");
  assert.ok((await ledgerPayable(merchantId)) > 0);
});

test("CP-1: an unpaid posted credit counts as pending, so reconciliation explains to zero", async () => {
  const { merchantId } = await createApprovedMerchantWithApiKey("cp1");
  const admin = await signedInAdmin("finance", "cp1");
  await createCreditRequest(pool, {
    merchantId,
    adminUserId: admin.id,
    body: { baseAmountFils: 7_500, reasonCode: "goodwill", effectiveDate: "2026-10-15", reverseFee: false },
  });
  const report = await getReconciliationReport(pool, { merchantId, from: "2026-10-15", to: "2026-10-16" });
  assert.equal(report.ledgerMerchantPayableNetFils, 7_500);
  assert.equal(report.pendingUnbatchedFils, 7_500);
  assert.equal(report.gapFils, 0);
});
