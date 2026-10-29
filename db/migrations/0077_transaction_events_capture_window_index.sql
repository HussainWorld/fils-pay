-- FIX (perf note 2026-07, follow-up that was never done): the settlement
-- summary filters capture events by time window. transaction_events had only
-- (transaction_id, occurred_at), so every summary seq-scanned the whole
-- table (402,911 rows / 1.8 s for one merchant in the July EXPLAIN).
-- A partial index on the capture event types by time lets Postgres read just
-- the window. (CONCURRENTLY is not used because migrations run in a txn.)
CREATE INDEX IF NOT EXISTS idx_transaction_events_capture_window
    ON transaction_events (occurred_at, transaction_id)
    INCLUDE (amount_fils)
 WHERE event_type IN ('captured', 'partially_captured');
