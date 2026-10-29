/** FP-240: the signature must verify over the exact bytes the merchant receives. */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { enqueueEvent } from "@filspay/events";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";
import { closeAll, config, createMerchant, pool } from "../fixesTestSupport.js";

test.after(closeAll);

test("a merchant verifying HMAC over the raw received body gets a match", async () => {
  const merchantId = await createMerchant("raw-sign");
  const url = `https://raw-sign-${randomUUID()}.example.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  // keys deliberately NOT in sorted order
  await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    payload: { merchantId, newStatus: "captured", amountCapturedFils: 4_750, feeFils: 71, capturedTotalFils: 4_750 },
  });
  const captured: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) captured.push(req);
    return { statusCode: 200, body: "" };
  };
  await runDispatchPass(pool, transport, config);
  assert.equal(captured.length, 1);
  const req = captured[0]!;
  const header = req.headers[WEBHOOK_SIGNATURE_HEADER]!;
  const [, t] = /t=(\d+)/.exec(header)!;
  const [, v1] = /v1=([0-9a-f]+)/.exec(header)!;
  const expected = createHmac("sha256", endpoint.secret).update(`${t}.${req.body}`).digest("hex");
  assert.equal(v1, expected, "signature must be over the bytes actually sent");
});
