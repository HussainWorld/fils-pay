/** A multi-part capture must be counted once per part, not running-total per part. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { getSettlementSummary } from "./query.js";
import { APPROVED_CARD, app, closeAll, createApprovedMerchantWithApiKey, pool } from "../fixesTestSupport.js";

test.after(closeAll);

test("summary of a transaction captured in 3 parts equals the 3 parts, not 1+2+3x", async () => {
  const m = await createApprovedMerchantWithApiKey("summary");
  const auth = await authorizeTransaction(pool, app.acquirer, {
    merchantId: m.merchantId,
    amountFils: toFils(9_000),
    card: APPROVED_CARD,
    idempotencyKey: randomUUID(),
    actor: { type: "system" },
  });
  const id = (auth.body as { id: string }).id;
  for (let i = 0; i < 3; i++) {
    const cap = await captureTransaction(pool, app.acquirer, {
      transactionId: id,
      merchantId: m.merchantId,
      amountFils: toFils(3_000),
      idempotencyKey: randomUUID(),
      actor: { type: "system", id },
    });
    assert.equal(cap.statusCode, 200, JSON.stringify(cap.body));
  }
  const day = (offset: number) => new Date(Date.now() + 3 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const summary = await getSettlementSummary(pool, { merchantId: m.merchantId, from: day(-1), to: day(1) });
  assert.equal(summary.transactionCount, 1);
  assert.equal(summary.totalCapturedFils, 9_000);
});
