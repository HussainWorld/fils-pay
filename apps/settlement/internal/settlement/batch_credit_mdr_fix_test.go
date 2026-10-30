package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// FIX CP-1 and MR-1 regression tests (DB-backed, DATABASE_URL).

func insertPostedCredit(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, base, feeReversal int64, effective string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var adminID, creditID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO admin_users (email, password_hash, display_name, role)
		VALUES ($1, 'x', 'CP-1 test', 'finance') RETURNING id`, "cp1-"+uuid.NewString()+"@admin.test").Scan(&adminID); err != nil {
		t.Fatalf("insert admin: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO credit_requests (merchant_id, requested_by_admin_user_id, requested_by_display_name, reason_code,
		                             base_amount_fils, fee_reversal_fils, effective_date, requires_approval, status, posted_at,
		                             ledger_entry_group_id)
		VALUES ($1, $2, 'CP-1 test', 'goodwill', $3, $4, $5, false, 'posted', now(), gen_random_uuid()) RETURNING id`,
		merchantID, adminID, base, feeReversal, effective).Scan(&creditID); err != nil {
		t.Fatalf("insert credit: %v", err)
	}
	return creditID
}

func TestCloseBatch_PaysPostedCreditsOnce(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	ast := time.FixedZone("AST", 3*3600)
	day1 := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)

	_, fee := insertCaptureEvent(t, pool, merchantID, 250, money.Fils(10_000), time.Date(2026, 4, 10, 9, 0, 0, 0, ast))
	credit := insertPostedCredit(t, pool, merchantID, 5_000, 125, "2026-04-09")
	future := insertPostedCredit(t, pool, merchantID, 7_000, 0, "2026-04-11")

	res1, err := CloseBatch(context.Background(), pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if want := money.Fils(10_000) - fee + 5_125; res1.NetPayoutFils != want {
		t.Errorf("day1 net = %d, want gross 10000 - fee %d + credit 5125 = %d", res1.NetPayoutFils, fee, want)
	}
	var credited int64
	var creditBatch, futureBatch *uuid.UUID
	ctx := context.Background()
	_ = pool.QueryRow(ctx, `SELECT credited_fils FROM settlement_batches WHERE id = $1`, res1.BatchID).Scan(&credited)
	_ = pool.QueryRow(ctx, `SELECT settlement_batch_id FROM credit_requests WHERE id = $1`, credit).Scan(&creditBatch)
	_ = pool.QueryRow(ctx, `SELECT settlement_batch_id FROM credit_requests WHERE id = $1`, future).Scan(&futureBatch)
	if credited != 5_125 || creditBatch == nil || *creditBatch != res1.BatchID || futureBatch != nil {
		t.Errorf("credited=%d creditBatch=%v futureBatch=%v; want 5125, %s, nil (future-dated waits)", credited, creditBatch, futureBatch, res1.BatchID)
	}

	res2, err := CloseBatch(context.Background(), pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if res2.NetPayoutFils != 7_000 {
		t.Errorf("day2 net = %d, want 7000 (only the credit effective that day; day1's is not paid twice)", res2.NetPayoutFils)
	}
}

func TestRecalculateMDR_UsesCurrentFeeScheduleNotStaleColumn(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250) // merchants.mdr_bps = 250 (stale)
	if _, err := pool.Exec(ctx, `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from) VALUES ($1, 225, '2026-01-01T00:00:00+03')`, merchantID); err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	day := time.Date(2026, 4, 12, 0, 0, 0, 0, time.UTC)
	insertCaptureEvent(t, pool, merchantID, 225, money.Fils(40_000), time.Date(2026, 4, 12, 9, 0, 0, 0, time.FixedZone("AST", 3*3600)))
	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if res.FeeFils != money.ApplyRateFils(40_000, 225) {
		t.Fatalf("close charged %d, want the schedule's 225 bps = %d", res.FeeFils, money.ApplyRateFils(40_000, 225))
	}

	rec, err := RecalculateMDR(ctx, pool, merchantID, day, day.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(rec.Adjusted) != 0 {
		t.Errorf("recalculating at the unchanged contract rate adjusted %+v; it re-priced at the stale 250 bps", rec.Adjusted)
	}
}
