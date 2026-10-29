import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll, config, createMerchant, parseCookie, signedInAdmin } from "../fixesTestSupport.js";

test.after(closeAll);

for (const role of ["finance", "super_admin"] as const) {
  test(`a ${role} impersonation grant is read-only too`, async () => {
    const admin = await signedInAdmin(role, `imp-${role}`);
    const merchantId = await createMerchant(`imp-${role}`);
    const startRes = await app.inject({
      method: "POST",
      url: `/v1/admin/merchants/${merchantId}/impersonate`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(startRes.statusCode, 201, startRes.body);
    const impCookie = parseCookie(startRes.headers["set-cookie"], config.impersonationCookieName);
    const write = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/payment-links`,
      headers: { cookie: impCookie },
      payload: { amountFils: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    assert.equal(write.statusCode, 403, write.body);
  });
}
