import type { PoolClient } from "pg";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** Truncates and repopulates the two rollup tables
 *  (merchant_daily_volume, merchant_payout_trends) from source. */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // FIX (B76): this rebuilds the rollups from source tables, which already
  // contain every committed capture — including ones whose outbox events the
  // reporting worker has not consumed yet. The worker's cursor was left
  // where it was, so it then applied those events again on top of the
  // rebuilt totals (double counting until the next rebuild), and a worker
  // pass running at the same time could interleave with the TRUNCATE.
  // Fix, all inside the caller's one transaction:
  //  1. REPEATABLE READ, so every statement below sees ONE snapshot (must be
  //     the first statement of the transaction — the route calls us first).
  //  2. Lock the cursor table before the snapshot is taken: waits for a
  //     running worker pass to commit and blocks new ones until we commit.
  //  3. Rebuild, then move the cursor to the newest event in that same
  //     snapshot and record the recent ones as applied (0082), so the worker
  //     continues exactly after what the rebuild already counted.
  await client.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
  await client.query(`LOCK TABLE reporting_outbox_cursor IN EXCLUSIVE MODE`);

  // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)
  await client.query(`TRUNCATE merchant_daily_volume`);
  await client.query(`TRUNCATE merchant_payout_trends`);

  const trendResult = await client.query(
    `INSERT INTO merchant_payout_trends
        (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
     SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
       FROM settlement_batches`,
  );

  const volumeResult = await client.query(
    `INSERT INTO merchant_daily_volume
        (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count,
         refund_count, refund_gross_fils, last_updated_at)
     SELECT t.merchant_id,
            (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date,
            COUNT(*) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')),
            COALESCE(SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')), 0),
            COUNT(*) FILTER (WHERE te.event_type = 'voided'),
            -- FIX (B76/FP-300): TRUNCATE above also wiped the refund columns
            -- (0078) and nothing put them back. Refund events carry a
            -- negative amount_fils (0044); the rollup stores it positive,
            -- like applyDailySummaryRollup does.
            COUNT(*) FILTER (WHERE te.event_type IN ('refunded', 'refund_partial')),
            COALESCE(-SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('refunded', 'refund_partial')), 0),
            now()
       FROM transaction_events te
       JOIN transactions t ON t.id = te.transaction_id
      WHERE te.event_type IN ('captured', 'partially_captured', 'voided', 'refunded', 'refund_partial')
      GROUP BY t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date`,
  );

  // FIX (B76) step 3. Same consumer name and lookback as apps/reporting
  // (runConsumerPass.ts CONSUMER_NAME / LATE_COMMIT_LOOKBACK).
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ('reporting', (SELECT COALESCE(MAX(id), 0) FROM outbox_events), now())
     ON CONFLICT (consumer_name) DO UPDATE
       SET last_processed_id = EXCLUDED.last_processed_id, updated_at = now()`,
  );
  await client.query(`DELETE FROM reporting_applied_events WHERE consumer_name = 'reporting'`);
  await client.query(
    `INSERT INTO reporting_applied_events (consumer_name, event_id)
     SELECT 'reporting', id FROM outbox_events WHERE created_at > now() - interval '2 hours'`,
  );

  return { volumeRows: volumeResult.rowCount ?? 0, trendRows: trendResult.rowCount ?? 0 };
}
