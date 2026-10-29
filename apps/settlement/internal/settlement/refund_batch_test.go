package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed int64, at time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
		                     created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq-refund', 'merchant_api_key', gen_random_uuid(), $5)
		RETURNING id`, txnID, merchantID, amount, feeReversed, at).Scan(&id)
	if err != nil {
		t.Fatalf("insert refund: %v", err)
	}
	return id
}

// FP-300: a refund comes out of the next payout, exactly once.
func TestCloseBatch_NetsRefundsOutOfThePayout(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 4, 20, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)

	txn1, fee1 := insertCaptureEvent(t, pool, merchantID, 250, 10_000, start.Add(time.Hour))
	_, fee2 := insertCaptureEvent(t, pool, merchantID, 250, 4_000, start.Add(2*time.Hour))
	refundID := insertRefund(t, pool, merchantID, txn1, 3_000, 75, start.Add(3*time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	wantGross := money.Fils(10_000 + 4_000 - 3_000)
	wantFee := fee1 + fee2 - 75
	if res.GrossFils != wantGross || res.FeeFils != wantFee || res.NetPayoutFils != wantGross-wantFee {
		t.Fatalf("batch = gross %d fee %d net %d, want %d %d %d", res.GrossFils, res.FeeFils, res.NetPayoutFils, wantGross, wantFee, wantGross-wantFee)
	}
	var batched *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batched); err != nil || batched == nil || *batched != res.BatchID {
		t.Fatalf("refund not attached to the batch: %v %v", batched, err)
	}

	// the next day's batch must not net the same refund again
	next, err := CloseBatch(ctx, pool, merchantID, day.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("CloseBatch next day: %v", err)
	}
	if next.NetPayoutFils != 0 {
		t.Fatalf("next-day net = %d, want 0 (refund already netted)", next.NetPayoutFils)
	}
}

// A day with more refunds than sales never produces a negative payout: the
// refund that does not fit waits for the next batch with enough sales.
func TestCloseBatch_RefundLargerThanTheDayCarriesForward(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 0)
	day := time.Date(2026, 4, 22, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)

	txn, _ := insertCaptureEvent(t, pool, merchantID, 0, 1_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txn, 5_000, 0, start.Add(2*time.Hour))
	first, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if first.NetPayoutFils != 1_000 {
		t.Fatalf("day 1 net = %d, want 1000 (refund carried, payout never negative)", first.NetPayoutFils)
	}

	nextStart, _ := BusinessDayWindow(day.AddDate(0, 0, 1))
	insertCaptureEvent(t, pool, merchantID, 0, 8_000, nextStart.Add(time.Hour))
	second, err := CloseBatch(ctx, pool, merchantID, day.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("CloseBatch day 2: %v", err)
	}
	if second.NetPayoutFils != 3_000 {
		t.Fatalf("day 2 net = %d, want 8000 - 5000 = 3000", second.NetPayoutFils)
	}
}
