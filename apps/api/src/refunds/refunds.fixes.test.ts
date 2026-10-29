/**
 * Regression tests for the refund fixes (FINDINGS.md R-1 … R-9), against a
 * real, migrated Postgres. Requires `DATABASE_URL`. Transactions are set up
 * through the real authorize/capture routes; refunds go through the real
 * POST routes unless a test needs a controllable acquirer.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund } from "../payments/processRefund.js";
import { buildEnvelope } from "../webhooks/envelope.js";
import { createWebhookEndpoint } from "../webhooks/create.js";
import { runDispatchPass } from "../webhooks/dispatcher.js";
import { WEBHOOK_SIGNATURE_HEADER } from "../webhooks/headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "../webhooks/transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.fixes.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "3",
});

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string, opts: { mdrBps?: number; discountBps?: number } = {}) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, $2, $3) RETURNING id`,
    [`Refund Fix ${label} ${randomUUID()}`, opts.mdrBps ?? 250, opts.discountBps ?? 0],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function captured(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD, reference: "refund-fix" },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(rawKey: string, body: Record<string, unknown>, key: string = randomUUID()) {
  return app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": key },
    payload: body,
  });
}

async function txnRow(id: string) {
  const r = await pool.query<{ status: string; refunded_fils: string }>(
    `SELECT status, refunded_fils FROM transactions WHERE id = $1`,
    [id],
  );
  return { status: r.rows[0]!.status, refundedFils: Number(r.rows[0]!.refunded_fils) };
}

async function feeReversed(transactionId: string): Promise<number[]> {
  const r = await pool.query<{ fee_reversed_fils: string }>(
    `SELECT fee_reversed_fils FROM refunds WHERE transaction_id = $1 ORDER BY occurred_at, created_at`,
    [transactionId],
  );
  return r.rows.map((row) => Number(row.fee_reversed_fils));
}

test("R-1: a refund without a reason succeeds and records 'unspecified'", async () => {
  const { rawKey } = await merchantWithKey("r1");
  const id = await captured(rawKey, 5_000);
  const res = await refund(rawKey, { transactionId: id });
  assert.equal(res.statusCode, 200, res.body);
  const r = await pool.query<{ reason: string }>(`SELECT reason FROM refunds WHERE transaction_id = $1`, [id]);
  assert.equal(r.rows[0]!.reason, "unspecified");
});

test("R-2: a partially captured transaction cannot refund more than was captured", async () => {
  const { rawKey } = await merchantWithKey("r2");
  const id = await captured(rawKey, 10_000, 4_000);

  const over = await refund(rawKey, { transactionId: id, amountFils: 10_000 });
  assert.equal(over.statusCode, 422, over.body);
  assert.deepEqual(over.json(), { ok: false, code: "refund_exceeds_refundable", refundableFils: 4_000 });

  const all = await refund(rawKey, { transactionId: id });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal((all.json() as { amountFils: number }).amountFils, 4_000);

  const again = await refund(rawKey, { transactionId: id, amountFils: 1 });
  assert.equal(again.statusCode, 422, again.body); // nothing left: refunded == captured
  assert.equal((await txnRow(id)).refundedFils, 4_000);
});

test("R-3 (FP-209): two concurrent full refunds with different keys move money out only once", async () => {
  const { merchantId, rawKey } = await merchantWithKey("r3");
  const id = await captured(rawKey, 7_000);
  const key = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [merchantId]);
  const actor = { type: "merchant_api_key" as const, id: key.rows[0]!.id };

  let acquirerRefunds = 0;
  const slowAcquirer: AcquirerSimulator = {
    authorize() {
      throw new Error("unused");
    },
    capture() {
      throw new Error("unused");
    },
    async refund(req): Promise<AcquirerRefundResult> {
      acquirerRefunds += 1;
      await new Promise((resolve) => setTimeout(resolve, 150)); // the window the race used to exploit
      return { outcome: "approved", acquirerReference: req.acquirerReference, latencyMs: 150 };
    },
  };

  const [a, b] = await Promise.all([
    processRefund(pool, slowAcquirer, { transactionId: id, merchantId, idempotencyKey: randomUUID(), actor }),
    processRefund(pool, slowAcquirer, { transactionId: id, merchantId, idempotencyKey: randomUUID(), actor }),
  ]);

  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([a, b]));
  assert.equal(acquirerRefunds, 1, "the acquirer must be asked to refund exactly once");
  assert.equal((await txnRow(id)).refundedFils, 7_000);
  const rows = await pool.query(`SELECT 1 FROM refunds WHERE transaction_id = $1`, [id]);
  assert.equal(rows.rowCount, 1);
});

test("R-4: a merchant cannot refund another merchant's transaction", async () => {
  const victim = await merchantWithKey("r4-victim");
  const attacker = await merchantWithKey("r4-attacker");
  const id = await captured(victim.rawKey, 9_000);

  const res = await refund(attacker.rawKey, { transactionId: id });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal((await txnRow(id)).refundedFils, 0);

  const viaPath = await app.inject({
    method: "POST",
    url: `/v1/merchants/${victim.merchantId}/refunds`,
    headers: { authorization: `Bearer ${attacker.rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: id },
  });
  assert.equal(viaPath.statusCode, 403, viaPath.body);
});

test("R-5: partial refunds reverse exactly the fee charged in total, to the fil", async () => {
  const { rawKey } = await merchantWithKey("r5", { mdrBps: 250 });
  const id = await captured(rawKey, 1_000); // fee 25
  for (const amountFils of [333, 333, 334]) {
    const res = await refund(rawKey, { transactionId: id, amountFils });
    assert.equal(res.statusCode, 200, res.body);
  }
  const reversals = await feeReversed(id);
  assert.equal(reversals.reduce((a, b) => a + b, 0), 25, `reversals ${reversals.join("+")} must sum to the fee`);
  assert.equal((await txnRow(id)).status, "refunded");
});

test("R-6: a discounted merchant gets back the fee actually charged, not the pre-discount fee", async () => {
  const { rawKey } = await merchantWithKey("r6", { mdrBps: 250, discountBps: 2_000 });
  const id = await captured(rawKey, 10_000); // fee 250, discount adjustment 50 → net fee 200
  const net = await pool.query<{ fee: string }>(
    `SELECT SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS fee
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [id],
  );
  assert.equal(Number(net.rows[0]!.fee), 200);

  const res = await refund(rawKey, { transactionId: id });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await feeReversed(id), [200]);
  const after = await pool.query<{ fee: string }>(
    `SELECT SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS fee
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [id],
  );
  assert.equal(Number(after.rows[0]!.fee), 0, "a full refund leaves no fee revenue on the transaction");
});

test("R-7: the merchant-path route works and replaying its idempotency key refunds once", async () => {
  const { merchantId, rawKey } = await merchantWithKey("r7");
  const id = await captured(rawKey, 3_000);
  const key = randomUUID();
  const send = () =>
    app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/refunds`,
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": key },
      payload: { transactionId: id, amountFils: 1_000, reason: "customer return" },
    });
  const first = await send();
  const second = await send();
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());
  assert.equal((await txnRow(id)).refundedFils, 1_000);

  const bad = await refund(rawKey, { transactionId: "not-a-uuid" });
  assert.equal(bad.statusCode, 400, bad.body);
});

test("R-8: refund.succeeded has a public webhook envelope", () => {
  const transactionId = randomUUID();
  const envelope = buildEnvelope("dlv_1", {
    eventType: "refund.succeeded",
    aggregateId: transactionId,
    createdAt: new Date("2026-10-29T10:00:00Z"),
    payload: {
      merchantId: "m1",
      refundId: "r1",
      amountFils: 1_000,
      feeReversedFils: 25,
      refundedTotalFils: 1_000,
      newStatus: "refunded",
    },
  });
  assert.deepEqual(envelope, {
    id: "dlv_1",
    type: "refund.succeeded",
    createdAt: "2026-10-29T10:00:00.000Z",
    data: {
      refundId: "r1",
      transactionId,
      merchantId: "m1",
      amountFils: 1_000,
      feeReversedFils: 25,
      refundedTotalFils: 1_000,
      transactionStatus: "refunded",
    },
  });
});

test("R-8/R-9 (FP-240): a refund webhook is delivered and its signature verifies over the raw body bytes", async () => {
  const { merchantId } = await merchantWithKey("r9");
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url: "https://merchant.example.test/hooks",
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  await enqueueEvent(pool, {
    eventType: "refund.succeeded",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, refundId: randomUUID(), amountFils: 500, feeReversedFils: 12, refundedTotalFils: 500, newStatus: "refunded" },
  });

  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    sent.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);

  const mine = sent.find((req) => req.url === endpoint.url && req.body.includes('"refund.succeeded"'));
  assert.ok(mine, "a refund.succeeded delivery must reach the merchant endpoint");

  // Verify the way a merchant does: HMAC over `${t}.${rawBody}` with the exact bytes received.
  const header = mine.headers[WEBHOOK_SIGNATURE_HEADER]!;
  const t = /t=(\d+)/.exec(header)![1];
  const v1 = /v1=([0-9a-f]+)/.exec(header)![1];
  const expected = createHmac("sha256", endpoint.secret).update(`${t}.${mine.body}`).digest("hex");
  assert.equal(v1, expected);
});
