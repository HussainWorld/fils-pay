import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll, createApprovedMerchantWithApiKey, createLink, pool } from "../fixesTestSupport.js";

test.after(closeAll);

test("merchant A cannot cancel merchant B's payment link (IDOR)", async () => {
  const a = await createApprovedMerchantWithApiKey("idor-a");
  const b = await createApprovedMerchantWithApiKey("idor-b");
  const bLink = await createLink(b.rawKey, b.merchantId);

  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${a.merchantId}/payment-links/${bLink.id}`,
    headers: { authorization: `Bearer ${a.rawKey}` },
  });
  assert.equal(res.statusCode, 404, res.body);
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [bLink.id]);
  assert.equal(row.rows[0]!.status, "active");
});

test("a merchant can still cancel its own link", async () => {
  const a = await createApprovedMerchantWithApiKey("own-cancel");
  const link = await createLink(a.rawKey, a.merchantId);
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${a.merchantId}/payment-links/${link.id}`,
    headers: { authorization: `Bearer ${a.rawKey}` },
  });
  assert.equal(res.statusCode, 204, res.body);
});

import { randomUUID } from "node:crypto";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { APPROVED_CARD } from "../fixesTestSupport.js";

test("FP-187: an expired link cannot be paid by sending an old submittedAt", async () => {
  const m = await createApprovedMerchantWithApiKey("expiry");
  const link = await createLink(m.rawKey, m.merchantId);
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 hour' WHERE id = $1`, [link.id]);
  const res = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: APPROVED_CARD, submittedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 410, res.body);
  const txns = await pool.query(`SELECT 1 FROM transactions WHERE merchant_id = $1`, [m.merchantId]);
  assert.equal(txns.rowCount, 0);
});

test("incident 05-14: a slow payment cannot let a second buyer pay the same link", { timeout: 30_000 }, async () => {
  // Acquirer slower than the reservation timeout: exactly the incident.
  const slowConfig = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: "test",
    ACQUIRER_FAILURE_RATE: "0",
    ACQUIRER_LATENCY_MIN_MS: "700",
    ACQUIRER_LATENCY_MAX_MS: "800",
    PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "1",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
  const slowApp = buildApp(slowConfig, pool);
  try {
    const m = await createApprovedMerchantWithApiKey("double-charge");
    const link = await createLink(m.rawKey, m.merchantId);
    const payOnce = () =>
      slowApp.inject({
        method: "POST",
        url: `/v1/payment-links/${link.token}/pay`,
        headers: { "idempotency-key": randomUUID() },
        payload: { card: APPROVED_CARD },
      });
    const first = payOnce();
    await new Promise((r) => setTimeout(r, 1_100)); // first is mid-capture, its reservation looks stale
    const second = payOnce();
    const results = await Promise.all([first, second]);
    const ok = results.filter((r) => r.statusCode === 200).length;
    assert.equal(ok, 1, results.map((r) => `${r.statusCode} ${r.body}`).join(" | "));
    const captured = await pool.query(
      `SELECT 1 FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`,
      [m.merchantId],
    );
    assert.equal(captured.rowCount, 1, "exactly one card charged");
  } finally {
    await slowApp.close();
  }
});
