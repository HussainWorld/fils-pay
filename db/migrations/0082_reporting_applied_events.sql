-- FIX (B75): the reporting consumer's only memory was a watermark
-- (`id > last_processed_id`). Outbox ids are allocated when a row is
-- INSERTed but become visible when the transaction COMMITs, so a slower
-- transaction holding a lower id could commit after the watermark had moved
-- past it, and that event was never applied to the rollups.
--
-- runConsumerPass now also re-reads the last hour of events and skips the
-- ones recorded here, so a late-committing event is applied exactly once.
-- Rows are pruned after a day (far outside the lookback window).
CREATE TABLE reporting_applied_events (
    consumer_name TEXT        NOT NULL,
    event_id      BIGINT      NOT NULL,
    applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer_name, event_id)
);

-- The lookback filters on created_at; without this it would scan the outbox.
CREATE INDEX idx_outbox_events_created_at ON outbox_events (created_at);

-- Everything at or below the current watermark has already been applied.
-- Record the recent part of it, or the first pass after deploy would apply
-- the last hour's events a second time.
INSERT INTO reporting_applied_events (consumer_name, event_id)
SELECT c.consumer_name, oe.id
  FROM outbox_events oe
  JOIN reporting_outbox_cursor c ON oe.id <= c.last_processed_id
 WHERE oe.created_at > now() - interval '2 hours'
ON CONFLICT DO NOTHING;
