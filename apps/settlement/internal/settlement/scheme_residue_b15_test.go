package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// B15 / ADR-0002: closing a batch posts each line's truncation residue as a
// balanced pair (credit card_scheme_clearing, debit scheme_rounding_residue),
// so gross = exported scheme amount + residue for the batch.
func TestCloseBatchPostsSchemeResidue(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 7, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	amounts := []money.Fils{4755, 4759, 1000, 12344} // residues 5, 9, 0, 4
	for i, a := range amounts {
		insertCaptureEvent(t, pool, merchantID, mdrBps, a, start.Add(time.Duration(i+1)*time.Hour))
	}
	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var debit, credit, groups int64
	err = pool.QueryRow(context.Background(), `
		SELECT COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'), 0),
		       COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing' AND direction = 'credit'), 0),
		       COUNT(DISTINCT entry_group_id)
		  FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND description = 'scheme export: rounding residue'
	`, result.BatchID).Scan(&debit, &credit, &groups)
	if err != nil {
		t.Fatal(err)
	}
	if debit != 18 || credit != 18 {
		t.Fatalf("residue posted debit=%d credit=%d, want 18/18 (old code posted nothing)", debit, credit)
	}
	if groups != 3 {
		t.Fatalf("got %d residue groups, want 3 (one per line with a residue)", groups)
	}

	var exported int64
	if err := pool.QueryRow(context.Background(),
		`SELECT SUM(amount_fils) FROM scheme_export_lines WHERE settlement_batch_id = $1`, result.BatchID,
	).Scan(&exported); err != nil {
		t.Fatal(err)
	}
	if exported+debit != 4755+4759+1000+12344 {
		t.Fatalf("exported %d + residue %d != gross", exported, debit)
	}

	// Re-running the close is a no-op: no second residue posting.
	if _, err := CloseBatch(context.Background(), pool, merchantID, businessDate); err != nil {
		t.Fatal(err)
	}
	var again int64
	_ = pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'scheme export: rounding residue'`,
		result.BatchID).Scan(&again)
	if again != 6 {
		t.Fatalf("got %d residue legs after re-run, want 6", again)
	}
}
