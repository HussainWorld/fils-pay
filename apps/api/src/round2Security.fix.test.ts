/**
 * Regression tests for checklist round 2, security/money group:
 * B64 (impersonation role gate), B72 (report scope), B69 (capture
 * idempotency), B48 (refund adjustment amount). Each one fails on the old
 * code and passes on the fixed code.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  APPROVED_CARD,
  app,
  closeAll,
  config,
  createApprovedMerchantWithApiKey,
  createMerchant,
  parseCookie,
  pool,
  signedInAdmin,
} from "./fixesTestSupport.js";
import { resolveReportMerchantId } from "./reporting/scope.js";
import { notifySettlementRefundAdjustment } from "./admin/settlementClient.js";

test.after(closeAll);

test("B64: every role ADMIN.md allows can start impersonation, and the grant stays read-only", async () => {
  for (const role of ["support", "finance", "super_admin"] as const) {
    const admin = await signedInAdmin(role, `b64-${role}`);
    const merchantId = await createMerchant(`b64-${role}`);
    const start = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/impersonate`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(start.statusCode, 201, `${role}: ${start.body}`);
    const imp = parseCookie(start.headers["set-cookie"], config.impersonationCookieName);
    const write = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { cookie: imp },
      payload: { amountFils: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(write.statusCode, 403, `${role} grant must be read-only`);
  }
});

test("B72: a merchant cannot scope a report to another marketplace's split child", async () => {
  const parentA = await createMerchant("b72-parent-a");
  const parentB = await createMerchant("b72-parent-b");
  const childOfB = await createMerchant("b72-child-b");
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 10000)`,
    [parentB, childOfB],
  );
  // B's own child: allowed.
  assert.equal(await resolveReportMerchantId(pool, parentB, childOfB), childOfB);
  // A asking for B's child: falls back to A's own scope (old code returned childOfB).
  assert.equal(await resolveReportMerchantId(pool, parentA, childOfB), parentA);
});

test("B69: reusing a capture Idempotency-Key on a different transaction is rejected, not replayed", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("b69");
  const auth = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/transactions",
      headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
      payload: { amountFils: 3_000, card: APPROVED_CARD, reference: "b69" },
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { id: string }).id;
  };
  const first = await auth();
  const second = await auth();
  const sharedKey = randomUUID();

  const cap1 = await app.inject({
    method: "POST",
    url: `/v1/transactions/${first}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": sharedKey },
    payload: {},
  });
  assert.equal(cap1.statusCode, 200, cap1.body);

  const cap2 = await app.inject({
    method: "POST",
    url: `/v1/transactions/${second}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": sharedKey },
    payload: {},
  });
  // Old code: 200 with the FIRST transaction's body, second never captured.
  assert.equal(cap2.statusCode, 422, cap2.body);
  assert.equal(cap2.json().error, "idempotency_key_reused");
  const status = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [second]);
  assert.equal(status.rows[0]!.status, "authorized");
});

test("B48: the refund adjustment sends integer fils unchanged", async () => {
  let received: { amountFils?: number; feeReversedFils?: number } = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    await notifySettlementRefundAdjustment(
      { settlementInternalUrl: `http://127.0.0.1:${port}`, settlementInternalToken: "t", settlementInternalRequestTimeoutMs: 2000 },
      { merchantId: randomUUID(), batchId: randomUUID(), refundId: randomUUID(), amountFils: 4_755, feeReversedFils: 107 },
    );
  } finally {
    server.close();
  }
  assert.equal(received.amountFils, 4_755); // old code sent 476
  assert.equal(received.feeReversedFils, 107);
});
