import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll, createApprovedMerchantWithApiKey, pool, signedInAdmin } from "../fixesTestSupport.js";

test.after(closeAll);

test("after an admin rotates a key, the old key no longer authenticates", async () => {
  const admin = await signedInAdmin("finance", "rotate");
  const m = await createApprovedMerchantWithApiKey("rotate");
  const key = await pool.query<{ id: string }>(`SELECT id FROM api_keys WHERE merchant_id = $1`, [m.merchantId]);
  const rot = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${m.merchantId}/api-keys/${key.rows[0]!.id}/rotate`,
    headers: { cookie: admin.cookie },
    payload: {},
  });
  assert.equal(rot.statusCode, 201, rot.body);
  const newKey = (rot.json() as { rawKey: string }).rawKey;

  const oldUse = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: `Bearer ${m.rawKey}` } });
  assert.equal(oldUse.statusCode, 401, "old key must be dead");
  const newUse = await app.inject({ method: "GET", url: "/v1/transactions", headers: { authorization: `Bearer ${newKey}` } });
  assert.equal(newUse.statusCode, 200, newUse.body);
});
