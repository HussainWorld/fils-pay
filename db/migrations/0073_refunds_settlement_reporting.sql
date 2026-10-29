-- FP-212 refunds, the settlement and reporting half.

-- FIX R-11: settlement batches had nowhere to record refunds, so CloseBatch ignored them and the
-- merchant was paid the full capture net even after money had gone back to the cardholder (the
-- ledger's merchant_payable went negative by every refund). net_payout_fils is now
-- gross - fee - refunded + fee_reversed.
ALTER TABLE settlement_batches
    ADD COLUMN refunded_fils     BIGINT NOT NULL DEFAULT 0 CHECK (refunded_fils >= 0),
    ADD COLUMN fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (fee_reversed_fils >= 0);

-- FIX R-10: applyEvent.ts's refund rollup writes these two columns, but no migration ever created
-- them, so the first refund event would have failed and stalled the reporting consumer.
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- FIX R-13: 0072 joined `t.id = r.id` (a refund id against a transaction id), so the view was always
-- empty; and summing t.captured_fils per refund row counted a transaction once per partial refund.
DROP MATERIALIZED VIEW refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH per_txn AS (
    SELECT r.merchant_id,
           r.transaction_id,
           date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
           COUNT(*)                 AS refund_count,
           SUM(r.amount_fils)       AS refunded_fils,
           SUM(r.fee_reversed_fils) AS fee_reversed_fils
      FROM refunds r
     WHERE r.status = 'succeeded'
     GROUP BY r.merchant_id, r.transaction_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain')
)
SELECT p.merchant_id,
       p.business_date,
       SUM(p.refund_count)      AS refund_count,
       SUM(p.refunded_fils)     AS total_refunded_fils,
       SUM(p.fee_reversed_fils) AS total_fee_reversed_fils,
       SUM(t.captured_fils)     AS original_captured_fils
  FROM per_txn p
  JOIN transactions t ON t.id = p.transaction_id
 GROUP BY p.merchant_id, p.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
