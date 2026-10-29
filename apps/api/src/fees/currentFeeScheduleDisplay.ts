import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's current negotiated fee schedule for display on the
 * admin merchant-detail page. We only need the newest schedule for display,
 * not point-in-time resolution — an admin looking at this page wants "what
 * did we most recently agree to for this merchant," not "what rate applied
 * to some specific past transaction" (that per-event resolution already
 * exists at capture/settlement time). Ordering by created_at is the
 * simplest way to answer "most recently agreed," since that's literally
 * when the row was entered.
 */
// MK 15/06/2026: shouldnt this be effective_from <= now() like feeSchedule.ts? a backdated
// correction entered today would show as "current"
// FH: asked Claude, it said created_at is right for "most recently agreed" (see docblock). resolved
// am: display only, nobody bills off this. leave it
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    // FIX (support: "dashboard shows 245bps, we charge 225bps"): this was
    // ORDER BY created_at DESC, i.e. "the row typed in last". A backdated
    // correction for March (245bps, keyed in on 15 Aug) beat the August
    // renegotiation (225bps) and was shown as "current", while capture
    // (feeSchedule.ts) and settlement (fee_schedule.go) correctly bill the
    // newest row whose effective_from has arrived. Use that same rule here
    // (as this file's own interface comment already says) so the screen
    // shows the rate we actually charge; a future-dated row is not shown yet.
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
