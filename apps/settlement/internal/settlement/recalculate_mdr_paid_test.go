package settlement

import (
	"context"
	"testing"
	"time"
)

// A paid batch's money has already left: recalculation must not touch it.
func TestRecalculateMDR_PaidBatchUntouched(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, 250, 4750, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("raise rate: %v", err)
	}

	from, to := recalcWindow(businessDate)
	result, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(result.Adjusted) != 0 {
		t.Errorf("adjusted %d paid batch(es), want 0", len(result.Adjusted))
	}
	var fee, net int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, closed.BatchID).Scan(&fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Errorf("paid batch changed: fee %d->%d, net %d->%d", closed.FeeFils, fee, closed.NetPayoutFils, net)
	}
}
