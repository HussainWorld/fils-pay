package settlement

import (
	"context"
	"testing"
)

// The counter must keep counting past int32 max (2,147,483,647 fils), and
// the tier must stay on once reached.
func TestPlatformProcessedVolume_NoOverflowPastInt32(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2100000000 WHERE id = 1`); err != nil {
		t.Fatalf("seed counter: %v", err)
	}
	current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, current, 100_000_000); err != nil {
		t.Fatalf("record: %v", err)
	}
	after, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if after != 2_200_000_000 {
		t.Errorf("counter = %d, want 2200000000", after)
	}
	if VolumeTierMdrBonusBps(after) != 15 {
		t.Errorf("tier switched off after passing int32 max")
	}
}
