import type { QueryableClient } from "@filspay/events";

/**
 * reporting_outbox_cursor read/advance — this consumer's own watermark,
 * never a reuse of outbox_events.processed_at.
 */
export interface ConsumerCursor {
  lastProcessedId: bigint;
}

/**
 * last_processed_id is BIGINT; pg returns it as a string, hence the union.
 */
interface CursorRow {
  last_processed_id: string | number;
}

/**
 * Seeds the row on first ever run (INSERT ... ON CONFLICT DO NOTHING),
 * then reads it. Never throws on a missing row — a worker's first pass
 * against a fresh database always starts from 0.
 */
// am: no FOR UPDATE on the cursor read, two passes can read the same watermark? nvm the `running` flag in listener.ts guards it
export async function readCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  // FIX (B74): the read had no lock, and the `running` flag am mentions
  // only guards passes inside ONE process. The worker daemon, `reporting
  // catch-up` (RUNBOOK says it is safe beside the worker) and a second
  // replica each read the same watermark, applied the same events and
  // double-counted the rollups (am's "rollup looked high" on 2026-09-14).
  // FOR UPDATE makes the cursor row the lock the runConsumerPass docblock
  // already claims it is: a second pass waits for the first to commit and
  // then reads the advanced watermark.
  const result = (await client.query(`SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = $1 FOR UPDATE`, [
    consumerName,
  ])) as { rows: CursorRow[] };

  const row = result.rows[0];
  return { lastProcessedId: row ? BigInt(row.last_processed_id) : 0n };
}

// YA: absolute SET is fine, only one writer.
export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  newLastProcessedId: bigint,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_id = $2, updated_at = now()
      WHERE consumer_name = $1`,
    [consumerName, newLastProcessedId.toString()],
  );
}

/** Resets this consumer's watermark to 0 — used only by the `rebuild`
 *  subcommand (cli/rebuild.ts) before replaying the entire outbox history. */
// MK: rebuild only. never call from the worker.
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ($1, 0, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0, updated_at = now()`,
    [consumerName],
  );
  // FIX (B75): a full replay starts from nothing, so forget which events the
  // late-commit lookback (runConsumerPass) has already applied too.
  await client.query(`DELETE FROM reporting_applied_events WHERE consumer_name = $1`, [consumerName]);
}
