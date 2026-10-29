package settlement

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// Scheme file amount must equal amount_fils / 1000 exactly (ADR-0002),
// i.e. truncated, never rounded up.
func TestSchemeExportAmountMatchesTruncatedFils(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	amounts := []money.Fils{4755, 4759, 1005, 12344}
	want := []string{"1.00", "12.34", "4.75", "4.75"} // sorted; lines are ordered by txn id
	for i, a := range amounts {
		insertCaptureEvent(t, pool, merchantID, mdrBps, a, start.Add(time.Duration(i+1)*time.Hour))
	}
	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	lines, err := LoadSchemeExportLines(context.Background(), pool, result.BatchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d", len(lines), len(want))
	}
	got := make([]string, len(lines))
	for i, line := range lines {
		got[i] = line.Amount
	}
	sort.Strings(got)
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("amounts = %v, want %v (truncated, not rounded)", got, want)
			break
		}
	}
}

// Net payout is exact integer gross - fee, even for large batches.
func TestNetPayableFilsExactForLargeBatches(t *testing.T) {
	cases := []struct{ gross, fee, want money.Fils }{
		{4_750, 119, 4_631},
		{123_456_789, 3_086_420, 120_370_369}, // > float32 precision
		{999_999_999_999, 1, 999_999_999_998},
	}
	for _, c := range cases {
		if got := NetPayableFils(c.gross, c.fee); got != c.want {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", c.gross, c.fee, got, c.want)
		}
	}
}
