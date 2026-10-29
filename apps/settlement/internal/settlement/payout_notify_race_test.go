package settlement

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Incident 2026-08-21: the daemon and run-batch notifying at the same time
// must still produce exactly one settlement.paid per batch.
func TestEnqueuePayoutNotifications_ConcurrentRunsNotifyOnce(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC), "paid", 5000)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()
	if n := countPaidEvents(t, pool, batchID); n != 1 {
		t.Fatalf("settlement.paid events for batch = %d, want 1", n)
	}
}
