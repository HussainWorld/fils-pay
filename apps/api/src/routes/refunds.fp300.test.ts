/**
 * FP-300 (refunds) end to end, one test per "done when" line on the ticket:
 *  1. works start to end through the API
 *  2. money right in the ledger, to the fil
 *  3. fees right (and payouts: see Go settlement/refund_batch_test.go)
 *  4. the shop gets the right webhook
 *  5. timeline, reports (apps/reporting refund test) and reconciliation
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { applyRateFils, toFils } from "@filspay/money";
import { createWebhookEndpoint } from "../webhooks/create.js";
import { runDispatchPass } from "../webhooks/dispatcher.js";
import { WEBHOOK_SIGNATURE_HEADER } from "../webhooks/headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "../webhooks/transport.js";
import {
  APPROVED_CARD,
  app,
  closeAll,
  config,
  createApprovedMerchantWithApiKey,
  parseCookie,
  pool,
  signedInAdmin,
} from "../fixesTestSupport.js";

test.after(closeAll);

const AUTH = 10_000;
const MDR = 250;
const DISCOUNT = 75;

async function setup() {
  const m = await createApprovedMerchantWithApiKey("fp300");
  await pool.query(`UPDATE merchants SET mdr_bps = $2, negotiated_discount_bps = $3 WHERE id = $1`, [
    m.merchantId,
    MDR,
    DISCOUNT,
  ]);
  const headers = { authorization: `Bearer ${m.rawKey}` };
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { amountFils: AUTH, card: APPROVED_CARD, reference: "fp300" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const txnId = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${txnId}/capture`,
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return { ...m, headers, txnId };
}

async function ledgerNet(txnId: string, account: string): Promise<number> {
  const r = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = $2`,
    [txnId, account],
  );
  return Number(r.rows[0]!.net);
}

function refund(s: { headers: Record<string, string>; txnId: string }, amountFils?: number, key: string = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { ...s.headers, "idempotency-key": key },
    payload: amountFils === undefined ? { transactionId: s.txnId } : { transactionId: s.txnId, amountFils },
  });
}

test("FP-300: partial + full refunds through both URLs, ledger, fees, webhook, timeline, reconciliation", async () => {
  const s = await setup();

  // the shop's webhook endpoint
  const hookUrl = `https://shop-${randomUUID()}.example.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: s.merchantId,
    url: hookUrl,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });

  // 3. fee charged at capture = the settlement formula (MDR on the discounted amount)
  const expectedFee = applyRateFils(toFils(AUTH - applyRateFils(toFils(AUTH), DISCOUNT)), MDR);
  assert.equal(await ledgerNet(s.txnId, "platform_fee_revenue"), expectedFee);

  // 1. through the API: two partials on /v1/refunds, the rest via the drawer URL
  const r1 = await refund(s, 3_333);
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().transactionStatus, "partially_refunded");
  const r1replay = await refund(s, 3_333, "fixed-key-" + s.txnId);
  const r1replay2 = await refund(s, 3_333, "fixed-key-" + s.txnId);
  assert.equal(r1replay.statusCode, 200, r1replay.body);
  assert.deepEqual(r1replay2.json(), r1replay.json(), "same Idempotency-Key = same refund, not a second one");
  const r3 = await app.inject({
    method: "POST",
    url: `/v1/merchants/${s.merchantId}/refunds`,
    headers: { ...s.headers, "idempotency-key": randomUUID() },
    payload: { transactionId: s.txnId, reason: "customer returned item" },
  });
  assert.equal(r3.statusCode, 200, r3.body);
  assert.equal(r3.json().transactionStatus, "refunded");
  assert.equal(r3.json().amountFils, AUTH - 3_333 - 3_333);

  // nothing left: a further refund is refused, and nothing moved
  const over = await refund(s, 1);
  assert.ok(over.statusCode === 409 || over.statusCode === 422, over.body);

  // 2. ledger to the fil: every account for this transaction nets to zero
  assert.equal(await ledgerNet(s.txnId, "merchant_payable"), 0);
  assert.equal(await ledgerNet(s.txnId, "platform_fee_revenue"), 0, "fee reversed exactly, not a fil more or less");
  assert.equal(await ledgerNet(s.txnId, "card_scheme_clearing"), 0);
  const unbalanced = await pool.query(
    `SELECT entry_group_id FROM ledger_entries WHERE transaction_id = $1 GROUP BY entry_group_id
      HAVING SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) <> 0`,
    [s.txnId],
  );
  assert.equal(unbalanced.rowCount, 0);
  const refunds = await pool.query<{ amount_fils: string; fee_reversed_fils: string }>(
    `SELECT amount_fils, fee_reversed_fils FROM refunds WHERE transaction_id = $1`,
    [s.txnId],
  );
  assert.equal(refunds.rowCount, 3);
  assert.equal(refunds.rows.reduce((a, r) => a + Number(r.amount_fils), 0), AUTH);
  assert.equal(refunds.rows.reduce((a, r) => a + Number(r.fee_reversed_fils), 0), expectedFee);

  // 5a. transaction + timeline
  const txn = await app.inject({ method: "GET", url: `/v1/transactions/${s.txnId}`, headers: s.headers });
  assert.equal(txn.json().status, "refunded");
  assert.equal(txn.json().refundedFils, AUTH);
  const events = (await app.inject({ method: "GET", url: `/v1/transactions/${s.txnId}/events`, headers: s.headers })).json() as Array<{
    eventType: string;
    amountFils: number;
  }>;
  const refundEvents = events.filter((e) => e.eventType === "refund_partial" || e.eventType === "refunded");
  assert.deepEqual(
    refundEvents.map((e) => [e.eventType, e.amountFils]),
    [
      ["refund_partial", -3_333],
      ["refund_partial", -3_333],
      ["refunded", -(AUTH - 6_666)],
    ],
  );

  // 4. the shop gets refund.succeeded, signed over the exact bytes it receives
  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === hookUrl) sent.push(req);
    return { statusCode: 200, body: "" };
  };
  await runDispatchPass(pool, transport, config);
  const refundHooks = sent
    .map((r) => ({ r, body: JSON.parse(r.body) as { type: string; data: { amountFils: number; transactionId: string } } }))
    .filter((x) => x.body.type === "refund.succeeded");
  assert.equal(refundHooks.length, 3);
  for (const { r } of refundHooks) {
    const header = r.headers[WEBHOOK_SIGNATURE_HEADER]!;
    const t = /t=(\d+)/.exec(header)![1];
    const v1 = /v1=([0-9a-f]+)/.exec(header)![1];
    assert.equal(v1, createHmac("sha256", endpoint.secret).update(`${t}.${r.body}`).digest("hex"));
  }
  assert.deepEqual(
    refundHooks.map((x) => x.body.data.amountFils).sort((a, b) => a - b),
    [3_333, 3_333, AUTH - 6_666].sort((a, b) => a - b),
  );
  assert.ok(refundHooks.every((x) => x.body.data.transactionId === s.txnId));

  // 5b. reconciliation explains everything (captured and refunded, nothing batched yet)
  const day = (offset: number) => new Date(Date.now() + 3 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const rec = await app.inject({
    method: "GET",
    url: `/v1/settlement/reconciliation?from=${day(0)}&to=${day(1)}`,
    headers: s.headers,
  });
  assert.equal(rec.statusCode, 200, rec.body);
  assert.equal(rec.json().gapFils, 0, rec.body);
  assert.equal(rec.json().explained, true);
});

test("FP-300: a merchant cannot refund another merchant's transaction, by either URL", async () => {
  const victim = await setup();
  const attacker = await createApprovedMerchantWithApiKey("fp300-attacker");
  const viaBody = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${attacker.rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: victim.txnId },
  });
  assert.equal(viaBody.statusCode, 404, viaBody.body);
  const viaPath = await app.inject({
    method: "POST",
    url: `/v1/merchants/${victim.merchantId}/refunds`,
    headers: { authorization: `Bearer ${attacker.rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: victim.txnId },
  });
  assert.equal(viaPath.statusCode, 403, viaPath.body);
  assert.equal(await ledgerNet(victim.txnId, "merchant_payable") > 0, true, "victim untouched");
});

test("FP-300: an admin viewing as the merchant cannot refund (read-only)", async () => {
  const s = await setup();
  const admin = await signedInAdmin("super_admin", "fp300-imp");
  const start = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${s.merchantId}/impersonate`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(start.statusCode, 201, start.body);
  const imp = parseCookie(start.headers["set-cookie"], config.impersonationCookieName);
  const res = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { cookie: imp, "idempotency-key": randomUUID() },
    payload: { transactionId: s.txnId },
  });
  assert.equal(res.statusCode, 403, res.body);
});

test("FP-300: bad input is a 4xx, never a 500", async () => {
  const s = await setup();
  for (const payload of [
    { transactionId: "not-a-uuid" },
    { transactionId: s.txnId, amountFils: 4.75 },
    { transactionId: s.txnId, amountFils: "100" },
    { transactionId: s.txnId, amountFils: -5 },
  ]) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: { ...s.headers, "idempotency-key": randomUUID() },
      payload,
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `${JSON.stringify(payload)} -> ${res.statusCode} ${res.body}`);
  }
});
