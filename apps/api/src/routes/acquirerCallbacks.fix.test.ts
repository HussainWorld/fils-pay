import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createMerchant, pool } from "../fixesTestSupport.js";

const SECRET = "acqsec_fix_test_secret";
const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: "test",
  ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET,
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function txn(): Promise<string> {
  const merchantId = await createMerchant("callbacks");
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, amount_fils, status, captured_fils, acquirer_reference)
     VALUES ($1, 1000, 'captured', 1000, $2) RETURNING id`,
    [merchantId, `acq-${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

function signRaw(raw: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`;
}

async function post(raw: string) {
  return app.inject({
    method: "POST",
    url: "/v1/acquirer/callbacks",
    headers: { "content-type": "application/json", "acquirer-callback-signature": signRaw(raw) },
    payload: raw,
  });
}

function body(transactionId: string, callbackId: string) {
  return {
    callbackId,
    type: "fraud_review.completed",
    transactionId,
    occurredAt: new Date().toISOString(),
    outcome: "cleared",
    note: "review complete",
  };
}

async function notes(callbackId: string): Promise<number> {
  const r = await pool.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1`, [callbackId]);
  return r.rowCount ?? 0;
}

test("FP-201: the same callback delivered twice (even concurrently) stores one note", async () => {
  const callbackId = `acqcb_${randomUUID()}`;
  const raw = JSON.stringify(body(await txn(), callbackId));
  const results = await Promise.all([post(raw), post(raw), post(raw)]);
  for (const r of results) assert.equal(r.statusCode, 200, r.body);
  assert.equal(await notes(callbackId), 1);
});

test("FP-240: a genuine callback whose bytes differ from JSON.stringify still verifies", async () => {
  const callbackId = `acqcb_${randomUUID()}`;
  // pretty-printed, exactly as signed by the acquirer
  const raw = JSON.stringify(body(await txn(), callbackId), null, 2);
  const res = await post(raw);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await notes(callbackId), 1);
});

test("an outcome outside the allowed values is rejected", async () => {
  const callbackId = `acqcb_${randomUUID()}`;
  const raw = JSON.stringify({ ...body(await txn(), callbackId), outcome: "lol" });
  const res = await post(raw);
  assert.equal(res.statusCode, 400, res.body);
});
