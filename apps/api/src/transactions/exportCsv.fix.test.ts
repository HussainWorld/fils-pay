/** Large export: streamed in pages, and no rows lost at page boundaries. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { streamTransactionsExportCsv } from "./exportCsv.js";
import { app, closeAll, createApprovedMerchantWithApiKey, pool } from "../fixesTestSupport.js";

test.after(closeAll);

test("2,500 transactions sharing one timestamp all come out of the export", { timeout: 60_000 }, async () => {
  const m = await createApprovedMerchantWithApiKey("export");
  await pool.query(
    `INSERT INTO transactions (merchant_id, amount_fils, status, captured_fils, acquirer_reference, occurred_at)
     SELECT $1::uuid, 1000, 'captured', 1000, 'exp-' || g || '-' || $1::text, '2026-09-01T10:00:00Z'
       FROM generate_series(1, 2500) g`,
    [m.merchantId],
  );
  const chunks: string[] = [];
  await streamTransactionsExportCsv(pool, { merchantId: m.merchantId }, (c) => chunks.push(c));
  const lines = chunks.join("").trim().split("\n");
  assert.equal(lines.length, 1 + 2500, "header + every row");

  const res = await app.inject({
    method: "GET",
    url: "/v1/transactions/export",
    headers: { authorization: `Bearer ${m.rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.split("\n").length, 1 + 2500);
});
