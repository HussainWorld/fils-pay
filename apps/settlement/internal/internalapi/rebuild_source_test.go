package internalapi

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// The console button must rebuild from ledger_entries, exactly like the
// CLI. A merchant with captured-but-not-yet-batched money has a real
// payable in the ledger and no scheme export lines yet.
func TestRebuildBalances_ReadsLedgerLikeCLI(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	merchantID := insertActiveMerchant(t, pool)
	insertCaptureEvent(t, pool, merchantID, 135000, time.Date(2026, 4, 13, 9, 0, 0, 0, time.UTC))

	var ledgerPayable int64
	if err := pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&ledgerPayable); err != nil {
		t.Fatalf("ledger sum: %v", err)
	}

	resp := post(t, server, "/internal/rebuild-balances", "Bearer "+testToken, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var diffs map[string]rebuildDiffResponse
	decodeJSON(t, resp, &diffs)
	diff, ok := diffs[merchantID.String()]
	if !ok {
		t.Fatalf("no diff entry for merchant %s", merchantID)
	}
	if diff.After != ledgerPayable {
		t.Errorf("rebuilt = %d, want ledger payable %d", diff.After, ledgerPayable)
	}
}
