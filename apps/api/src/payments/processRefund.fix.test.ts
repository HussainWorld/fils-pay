/** FP-209 and the "refund more than charged" note. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "./authorize.js";
import { captureTransaction } from "./capture.js";
import { processRefund } from "./processRefund.js";
import { APPROVED_CARD, app, closeAll, createApprovedMerchantWithApiKey, pool } from "../fixesTestSupport.js";

test.after(closeAll);

async function capturedTxn(authFils: number, captureFils?: number) {
  const m = await createApprovedMerchantWithApiKey("refund-fix");
  const auth = await authorizeTransaction(pool, app.acquirer, {
    merchantId: m.merchantId,
    amountFils: toFils(authFils),
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
    actor: { type: "system" },
  });
  assert.equal(auth.statusCode, 201, JSON.stringify(auth.body));
  const id = (auth.body as { id: string }).id;
  const cap = await captureTransaction(pool, app.acquirer, {
    transactionId: id,
    merchantId: m.merchantId,
    ...(captureFils === undefined ? {} : { amountFils: toFils(captureFils) }),
    idempotencyKey: randomUUID(),
    actor: { type: "system", id: id },
  });
  assert.equal(cap.statusCode, 200, JSON.stringify(cap.body));
  return { ...m, transactionId: id };
}

function refund(t: { merchantId: string; transactionId: string; ownerUserId: string }, amountFils?: number) {
  return processRefund(pool, app.acquirer, {
    transactionId: t.transactionId,
    merchantId: t.merchantId,
    ...(amountFils === undefined ? {} : { amountFils: toFils(amountFils) }),
    idempotencyKey: randomUUID(),
    actor: { type: "merchant_session", id: t.ownerUserId },
  });
}

test("FP-209: two concurrent full refunds -> exactly one succeeds", async () => {
  const t = await capturedTxn(5_000);
  const results = await Promise.all([refund(t), refund(t), refund(t)]);
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1, JSON.stringify(results));
  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [t.transactionId]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 5_000);
  const refunds = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [t.transactionId]);
  assert.equal(refunds.rowCount, 1);
});

test("cannot refund more than was captured on a partial capture", async () => {
  const t = await capturedTxn(10_000, 4_000);
  const res = await refund(t, 6_000);
  assert.equal(res.statusCode, 422, JSON.stringify(res.body));
});

test("a merchant cannot refund another merchant's transaction", async () => {
  const victim = await capturedTxn(3_000);
  const attacker = await createApprovedMerchantWithApiKey("refund-attacker");
  const res = await refund({ ...attacker, transactionId: victim.transactionId });
  assert.equal(res.statusCode, 404, JSON.stringify(res.body));
});
