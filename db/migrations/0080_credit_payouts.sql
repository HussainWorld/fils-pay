-- FIX CP-1: manual credits were journaled to the merchant's payable (ledger + balance cache) but no
-- settlement batch ever paid them out. CloseBatch only netted captures, fees and refunds, so a goodwill or
-- dispute credit raised the balance the merchant saw and then sat in merchant_payable forever, showing up
-- in reconciliation as an unexplained gap. A posted credit is now paid in the merchant's next batch:
-- CloseBatch claims it (settlement_batch_id, like refunds and capture events) and adds it to the payout.
ALTER TABLE credit_requests
    ADD COLUMN settlement_batch_id UUID REFERENCES settlement_batches (id);

CREATE INDEX idx_credit_requests_unbatched
    ON credit_requests (merchant_id, effective_date)
 WHERE status = 'posted' AND settlement_batch_id IS NULL;

-- net_payout_fils = gross_fils - fee_fils + credited_fils
ALTER TABLE settlement_batches
    ADD COLUMN credited_fils BIGINT NOT NULL DEFAULT 0 CHECK (credited_fils >= 0);
