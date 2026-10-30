/**
 * Regression tests for checklist round 2, webhook group:
 * B87 (endpoint delete with history), B84 (cross-replica claim),
 * B80 (response body limit), B37 (archive bounded).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { deleteWebhookEndpoint } from "./cancel.js";
import { runDispatchPass } from "./dispatcher.js";
import { createFetchTransport, type WebhookTransport } from "./transport.js";
import { MAX_ARCHIVE_DELIVERIES, createWebhookDeliveryArchive } from "./archiveReplay.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "5",
  WEBHOOK_REQUEST_TIMEOUT_MS: "5000",
});
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
test.after(() => pool.end());

async function merchantWithEndpoint(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`R2 webhooks ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const url = `http://${label}-${randomUUID()}.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  return { merchantId, endpointId: endpoint.id, url };
}

async function enqueueCaptured(merchantId: string) {
  return enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, amountCapturedFils: 1_000, feeFils: 25, newStatus: "captured", capturedTotalFils: 1_000 },
  });
}

test("B87: deleting an endpoint that has delivery history succeeds and keeps the history", async () => {
  const { merchantId, endpointId } = await merchantWithEndpoint("b87");
  await enqueueCaptured(merchantId);
  await runDispatchPass(pool, async () => ({ statusCode: 200, body: "ok" }), config);
  const before = await pool.query(`SELECT id FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId]);
  assert.equal(before.rows.length, 1);

  // Old schema: foreign-key violation (HTTP 500).
  assert.equal(await deleteWebhookEndpoint(pool, { merchantId, id: endpointId }), "deleted");
  const kept = await pool.query<{ endpoint_id: string | null }>(
    `SELECT endpoint_id FROM webhook_deliveries WHERE id = $1`,
    [before.rows[0].id],
  );
  assert.equal(kept.rows.length, 1, "delivery row retained");
  assert.equal(kept.rows[0]!.endpoint_id, null);
});

test("B84: two dispatcher passes running at once send a due delivery exactly once", async () => {
  const { merchantId, url } = await merchantWithEndpoint("b84");
  await enqueueCaptured(merchantId);
  // First pass creates the row and fails it, so the race below is on a
  // plain due retry (Step A is not part of it).
  await runDispatchPass(pool, async () => ({ statusCode: 500, body: "" }), config);
  await pool.query(
    `UPDATE webhook_deliveries wd SET next_attempt_at = now() - interval '1 second'
       FROM webhook_endpoints we WHERE we.id = wd.endpoint_id AND we.url = $1`,
    [url],
  );

  let sends = 0;
  const slow: WebhookTransport = async (req) => {
    if (req.url === url) sends += 1;
    await new Promise((r) => setTimeout(r, 300));
    return { statusCode: 200, body: "ok" };
  };
  await Promise.all([runDispatchPass(pool, slow, config), runDispatchPass(pool, slow, config)]);
  assert.equal(sends, 1, "old code: both replicas sent it");
});

test("B80: the fetch transport keeps only a bounded slice of a huge response body", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    const chunk = "x".repeat(64 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < 5 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return void res.once("drain", pump);
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await createFetchTransport()({
      url: `http://127.0.0.1:${port}/`,
      headers: { "Content-Type": "application/json" },
      body: "{}",
      timeoutMs: 5000,
    });
    assert.equal(result.statusCode, 500);
    assert.ok(result.body.length <= 8 * 1024, `kept ${result.body.length} chars (old code: all 5 MB)`);
    assert.ok(result.body.length > 0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("B37: an archive range larger than the cap is refused before it is loaded", async () => {
  const { merchantId, endpointId } = await merchantWithEndpoint("b37");
  const event = await enqueueCaptured(merchantId);
  await runDispatchPass(pool, async () => ({ statusCode: 200, body: "ok" }), config);
  const original = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE endpoint_id = $1`,
    [endpointId],
  );
  await pool.query(
    `INSERT INTO webhook_deliveries (endpoint_id, outbox_event_id, event_type, delivery_event_id, payload, status, replay_of_delivery_id)
     SELECT $1, $2, 'transaction.captured', gen_random_uuid(), '{}'::jsonb, 'succeeded', $3
       FROM generate_series(1, $4::int)`,
    [endpointId, event.id, original.rows[0]!.id, MAX_ARCHIVE_DELIVERIES],
  );
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'b37', 'support') RETURNING id`,
    [`b37-${randomUUID()}@admin.test`],
  );
  await assert.rejects(
    createWebhookDeliveryArchive(pool, {
      merchantId,
      endpointId,
      adminUserId: admin.rows[0]!.id,
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 3_600_000),
    }),
    (err: { statusCode?: number; code?: string }) => err.statusCode === 422 && err.code === "archive_range_too_large",
  );
});
