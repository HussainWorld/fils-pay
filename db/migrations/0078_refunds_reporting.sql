-- FP-300: refunds in the reports.
--
-- 1. The daily rollup (filled only by apps/reporting from the outbox) gets
--    refund columns, so analytics can show refunds next to captures.
ALTER TABLE merchant_daily_volume
    ADD COLUMN IF NOT EXISTS refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- 2. FIX: refund_merchant_summary (0072) joined `transactions t ON t.id =
--    r.id`, a refund id against a transaction id, which never matches, so
--    the view was always EMPTY. It also summed t.captured_fils once per
--    refund (two partial refunds on one transaction counted its capture
--    twice). Join on r.transaction_id and count each transaction once.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH r AS (
    SELECT merchant_id, transaction_id, amount_fils, fee_reversed_fils,
           date_trunc('day', occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date
      FROM refunds
     WHERE status = 'succeeded'
),
per_day AS (
    SELECT merchant_id, business_date,
           COUNT(*)               AS refund_count,
           SUM(amount_fils)       AS total_refunded_fils,
           SUM(fee_reversed_fils) AS total_fee_reversed_fils
      FROM r
     GROUP BY merchant_id, business_date
),
captured AS (
    SELECT d.merchant_id, d.business_date, SUM(t.captured_fils) AS original_captured_fils
      FROM (SELECT DISTINCT merchant_id, business_date, transaction_id FROM r) d
      JOIN transactions t ON t.id = d.transaction_id
     GROUP BY d.merchant_id, d.business_date
)
SELECT p.merchant_id, p.business_date, p.refund_count, p.total_refunded_fils,
       p.total_fee_reversed_fils, COALESCE(c.original_captured_fils, 0) AS original_captured_fils
  FROM per_day p
  LEFT JOIN captured c USING (merchant_id, business_date);

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
