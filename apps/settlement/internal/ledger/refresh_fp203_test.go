package ledger

import (
	"context"
	"testing"
)

// FP-203 regression: the console refresh must agree with the ledger (and so with the CLI), not with the
// truncated scheme export. Ledger owes 25,005 fils; the scheme line was truncated to 25,000; a
// payout of 20,000 already went out. The right cached balance is 5,005.
func TestRefreshBalanceCache_MatchesLedgerNotSchemeExport(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	postLedgerLeg(t, pool, merchantID, "credit", 25005)
	postLedgerLeg(t, pool, merchantID, "debit", 20000)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, '2026-06-20', 'paid', 25000, 0, 25000, now())`, merchantID); err != nil {
		t.Fatalf("insert batch: %v", err)
	}

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	cli, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if got := int64(diffs[merchantID].Rebuilt); got != 5005 || got != int64(cli) {
		t.Errorf("console refresh = %d, CLI = %d, want both 5005", got, cli)
	}
}
