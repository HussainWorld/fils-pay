import type { Pool } from "pg";

export async function resolveReportMerchantId(
  pool: Pool,
  callerMerchantId: string,
  requestedMerchantId?: string,
): Promise<string> {
  if (!requestedMerchantId || requestedMerchantId === callerMerchantId) {
    return callerMerchantId;
  }

  // FIX (B72): this only asked "is the requested merchant a split child of
  // ANYONE?", not "of the caller?". Any merchant could pass another
  // marketplace's child id and read that child's transactions/reports.
  // One extra predicate binds the child to the authenticated parent; an
  // unrelated id falls through to the caller's own scope exactly like an
  // unknown id already did.
  const result = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM merchant_split_children WHERE child_merchant_id = $1 AND parent_merchant_id = $2`,
    [requestedMerchantId, callerMerchantId],
  );
  if (result.rows.length === 0) {
    return callerMerchantId;
  }
  return requestedMerchantId;
}
