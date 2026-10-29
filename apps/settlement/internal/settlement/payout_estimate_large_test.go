package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// High-volume merchants: past 2^24 fils a float4 accumulator drops fils.
func TestLifetimePayoutEstimate_ExactForHighVolume(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var want int64
	for _, net := range []money.Fils{20_000_001, 3, 7, 135_000_123, 1} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("update: %v", err)
		}
		want += int64(net)
	}
	var got int64
	if err := tx.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate::bigint FROM merchants WHERE id = $1`, merchantID).Scan(&got); err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != want {
		t.Errorf("estimate = %d, want %d (drift %d fils)", got, want, got-want)
	}
}
