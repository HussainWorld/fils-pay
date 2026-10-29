import type { Pool } from "pg";

export type CancelPaymentLinkResult =
  | { outcome: "canceled" }
  | { outcome: "not_found" }
  | { outcome: "not_cancelable"; status: string };

/** Cancels an active payment link by id, only if it belongs to merchantId. */
// FIX (group chat: "I cancelled merchant B's payment link from merchant A's
// dashboard"): the UPDATE matched on the link id alone. The route's
// assertOwnMerchant only checks that the caller is the merchant in the URL
// path, not that the LINK belongs to that merchant, so merchant A could call
// DELETE /v1/merchants/A/payment-links/<B's link id> and cancel B's link
// (IDOR). ARCHITECTURE: "Merchant-scoped queries take the merchant from the
// authenticated context". Both queries are now scoped by merchant_id, and a
// link of another merchant is reported as not_found (no existence leak).
export async function cancelPaymentLink(
  pool: Pool,
  input: { id: string; merchantId: string },
): Promise<CancelPaymentLinkResult> {
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE payment_links
        SET status = 'canceled', canceled_at = now()
      WHERE id = $1 AND merchant_id = $2 AND status = 'active'
      RETURNING id`,
    [input.id, input.merchantId],
  );
  if (updateResult.rows[0]) {
    return { outcome: "canceled" };
  }

  // YA: second read is just for the error shape, no race. fine
  const lookupResult = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1 AND merchant_id = $2`,
    [input.id, input.merchantId],
  );
  const row = lookupResult.rows[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  return { outcome: "not_cancelable", status: row.status };
}
