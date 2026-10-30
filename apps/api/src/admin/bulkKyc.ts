import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/** Approves the given merchants and audits it. */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    // FIX (B85): ADMIN.md ("Only merchants currently `under_review` are
    // affected") and the result docblock above both promise a state check,
    // but the UPDATE matched every id sent — a rejected merchant (or a
    // brand-new one that never submitted documents) ticked by mistake was
    // approved and KYC-passed in bulk. It also skipped the per-merchant
    // review trail the single "KYC review" action writes. Two changes:
    // the state predicate, and one merchant_kyc_reviews row per merchant
    // actually approved (same columns recordKycReviewInTx writes).
    const result = await client.query<{ id: string }>(
      `UPDATE merchants
          SET onboarding_status = 'approved', kyc_passed = true
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
      RETURNING id`,
      [input.merchantIds],
    );
    const approvedMerchantIds = result.rows.map((row) => row.id);

    if (approvedMerchantIds.length > 0) {
      await client.query(
        `INSERT INTO merchant_kyc_reviews (merchant_id, outcome, reviewer_identifier, reviewer_admin_user_id, notes)
         SELECT m.id, 'approved', au.email, au.id, $3
           FROM unnest($1::uuid[]) AS m(id)
           JOIN admin_users au ON au.id = $2`,
        [approvedMerchantIds, input.adminUserId, input.notes ?? null],
      );
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}
