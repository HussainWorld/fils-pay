/**
 * Regression test for checklist round 2, B85: bulk KYC approve only touches
 * merchants that are under_review, and leaves a per-merchant review trail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { app, closeAll, createMerchant, pool, signedInAdmin } from "./fixesTestSupport.js";

test.after(closeAll);

test("B85: bulk approve skips merchants not under_review and writes merchant_kyc_reviews", async () => {
  const finance = await signedInAdmin("finance", "b85");
  const pending = await createMerchant("b85-pending");
  const rejected = await createMerchant("b85-rejected");
  await pool.query(`UPDATE merchants SET onboarding_status = 'under_review' WHERE id = $1`, [pending]);
  await pool.query(`UPDATE merchants SET onboarding_status = 'rejected', kyc_passed = false WHERE id = $1`, [rejected]);

  const res = await app.inject({
    method: "POST",
    url: "/v1/admin/merchants/bulk-approve",
    headers: { cookie: finance.cookie },
    payload: { merchantIds: [pending, rejected], notes: "b85" },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual((res.json() as { approvedMerchantIds: string[] }).approvedMerchantIds, [pending]);

  const states = await pool.query<{ id: string; onboarding_status: string; kyc_passed: boolean }>(
    `SELECT id, onboarding_status, kyc_passed FROM merchants WHERE id = ANY($1)`,
    [[pending, rejected]],
  );
  const byId = new Map(states.rows.map((r) => [r.id, r]));
  assert.equal(byId.get(pending)!.onboarding_status, "approved");
  assert.equal(byId.get(rejected)!.onboarding_status, "rejected", "old code approved a rejected merchant");
  assert.equal(byId.get(rejected)!.kyc_passed, false);

  const reviews = await pool.query<{ merchant_id: string; reviewer_admin_user_id: string }>(
    `SELECT merchant_id, reviewer_admin_user_id FROM merchant_kyc_reviews WHERE merchant_id = ANY($1)`,
    [[pending, rejected]],
  );
  assert.equal(reviews.rows.length, 1, "old code wrote no per-merchant review");
  assert.equal(reviews.rows[0]!.merchant_id, pending);
  assert.equal(reviews.rows[0]!.reviewer_admin_user_id, finance.id);
});
