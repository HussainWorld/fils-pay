import type { Pool } from "pg";

/** Operational record of a payout-rail instruction for a settlement batch. */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  // FIX (incident 2026-08-21, the money side of it): this runs as a
  // "pre-delivery effect" of EVERY settlement.paid webhook delivery, i.e.
  // once per (event x merchant webhook endpoint), and again if a delivery
  // is re-attempted from attempt_count 0 after a crash. Duplicate
  // settlement.paid events (the 08-21 race), or simply a merchant with two
  // webhook endpoints, therefore wrote two payout instructions for one
  // batch: the merchant could be paid twice. A batch has exactly one
  // disbursement: serialize per batch (transaction-scoped advisory lock)
  // and insert only if none exists yet.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('payout_disbursement:' || $1::text))`, [
      settlementBatchId,
    ]);
    await client.query(
      `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
       SELECT $1, $2, 'disb_' || gen_random_uuid()
        WHERE NOT EXISTS (SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1)`,
      [settlementBatchId, amountFils],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
