import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll, createMerchant, pool, signedInAdmin } from "../fixesTestSupport.js";

test.after(closeAll);

test("recompute-statuses does not turn a test-mode merchant live", async () => {
  const admin = await signedInAdmin("finance");
  const merchantId = await createMerchant("sandbox", { testMode: true });
  // one settled (non-open) transaction so the old code's condition is met
  await pool.query(
    `INSERT INTO transactions (merchant_id, amount_fils, status, captured_fils, acquirer_reference)
     VALUES ($1, 1000, 'captured', 1000, $2)`,
    [merchantId, `fix-${merchantId}`],
  );
  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
  assert.equal(row.rows[0]!.test_mode, true);
});
