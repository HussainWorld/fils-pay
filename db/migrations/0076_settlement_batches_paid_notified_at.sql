-- FIX (incident 2026-08-21 "shops got two 'your payout is on the way'
-- messages"): EnqueuePayoutNotifications decided "not notified yet" with a
-- NOT EXISTS read and then INSERTed in a separate statement. The daemon and
-- a `run-batch` (or two daemons) running at the same moment both saw
-- NOT EXISTS = true and both inserted settlement.paid. The code comment
-- relied on "a unique index on (event_type, aggregate_id)" that no
-- migration ever created.
-- This column is the claim: the notifier flips it with
-- UPDATE ... WHERE paid_notified_at IS NULL, which only one process can win.
ALTER TABLE settlement_batches ADD COLUMN paid_notified_at TIMESTAMPTZ;

-- Batches already notified must not be notified again.
UPDATE settlement_batches sb
   SET paid_notified_at = now()
 WHERE EXISTS (SELECT 1 FROM outbox_events oe
                WHERE oe.event_type = 'settlement.paid' AND oe.aggregate_id = sb.id);
