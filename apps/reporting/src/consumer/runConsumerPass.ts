import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

// am: refund.succeeded not here yet. when refunds ship just add it to the list
export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "refund.succeeded", // FP-300
  // FIX (B78): payout trends cache each batch's status/paid_at, but only
  // settlement.batch_closed was consumed. A batch closes 'closed' and is
  // marked paid later, so trends showed it unpaid until someone ran a full
  // rebuild. settlement.paid now refreshes that one row (applyEvent).
  "settlement.paid",
];

/**
 * FIX (B75): how far back (by outbox created_at, i.e. the producing
 * transaction's start) each pass re-checks for events that committed after
 * the watermark had already moved past their id. Producing transactions
 * are seconds long; an hour is a wide safety margin.
 */
export const LATE_COMMIT_LOOKBACK = "1 hour";

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * The `SELECT` below is a plain, unlocked read — no row lock, no
 * `FOR UPDATE`, no mutation of any outbox_events column — identical
 * posture to webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    // MK 2026-06: ids come from a sequence, they're monotonic. fine for now.
    // FIX (B75): ids are monotonic in ALLOCATION order, not COMMIT order.
    // Transaction A takes id 10, B takes id 11 and commits first; a pass
    // sees 11, moves the watermark to 11, and when A commits, `id > 11`
    // never selects 10 — that capture/refund was silently missing from the
    // rollups forever. Keep the watermark for the normal case and ALSO
    // re-check the last LATE_COMMIT_LOOKBACK of events, skipping the ones
    // already applied (reporting_applied_events, migration 0082) so nothing
    // is applied twice.
    const eventsResult = await client.query<OutboxEventRow>(
      `SELECT oe.id, oe.event_type, oe.aggregate_id, oe.payload, oe.created_at
         FROM outbox_events oe
        WHERE (oe.id > $1 OR oe.created_at > now() - $5::interval)
          AND oe.event_type = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM reporting_applied_events a
                           WHERE a.consumer_name = $4 AND a.event_id = oe.id)
        ORDER BY oe.id ASC
        LIMIT $3`,
      [
        cursor.lastProcessedId.toString(),
        REPORTING_EVENT_TYPES,
        config.consumerBatchLimit,
        CONSUMER_NAME,
        LATE_COMMIT_LOOKBACK,
      ],
    );

    // FH: redundant with ORDER BY id ASC (last row is max). harmless
    let maxId = cursor.lastProcessedId;
    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
      const rowId = BigInt(row.id);
      if (rowId > maxId) maxId = rowId;
    }

    if (eventsResult.rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
      // FIX (B75): remember what was applied, so the lookback never applies
      // it again; rows older than a day are far outside the lookback.
      await client.query(
        `INSERT INTO reporting_applied_events (consumer_name, event_id)
         SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`,
        [CONSUMER_NAME, eventsResult.rows.map((r) => String(r.id))],
      );
      await client.query(
        `DELETE FROM reporting_applied_events WHERE consumer_name = $1 AND applied_at < now() - interval '1 day'`,
        [CONSUMER_NAME],
      );
    }

    return { processedCount: eventsResult.rows.length };
  });
}
