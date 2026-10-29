-- FIX (group chat: "lifetime payout estimate drifts for high-volume
-- merchants"): 0040 made this column REAL (float4) and PayoutBatch added
-- float32(net) to it. float4 has a 24-bit mantissa, so above 16,777,216
-- fils (~16,777 BD) it can no longer represent every whole fil: each
-- addition is rounded to the nearest representable value, and small
-- payouts on a big total are partly or completely lost. Busy merchants pass
-- that within weeks, so the figure drifts further from reality every batch.
-- ADR-0001: money is integer fils in BIGINT. Change the type and recompute
-- the already-drifted values from the paid batches they summarise.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;

UPDATE merchants m
   SET lifetime_net_payout_monitoring_estimate = COALESCE((
         SELECT SUM(sb.net_payout_fils) FROM settlement_batches sb
          WHERE sb.merchant_id = m.id AND sb.status = 'paid'), 0);
