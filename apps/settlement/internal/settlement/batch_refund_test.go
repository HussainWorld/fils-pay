package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// FIX R-11 regression tests: refunds reduce the merchant's next batch.

func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed int64, occurredAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq-refund', 'test', 'merchant_api_key', $5, $6)
		RETURNING id`, txnID, merchantID, amount, feeReversed, uuid.New(), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertRefund: %v", err)
	}
	return id
}

func TestCloseBatch_DeductsRefunds(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	at := time.Date(2026, 3, 10, 9, 0, 0, 0, time.FixedZone("AST", 3*3600))

	txnID, fee := insertCaptureEvent(t, pool, merchantID, 250, money.Fils(10_000), at)
	refundID := insertRefund(t, pool, merchantID, txnID, 4_000, 100, at.Add(time.Hour))

	res, err := CloseBatch(context.Background(), pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	want := money.Fils(10_000) - fee - 4_000 + 100
	if res.NetPayoutFils != want {
		t.Errorf("net = %d, want gross 10000 - fee %d - refunded 4000 + fee reversed 100 = %d", res.NetPayoutFils, fee, want)
	}
	var refunded, reversed int64
	var refundBatch *uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`SELECT refunded_fils, fee_reversed_fils FROM settlement_batches WHERE id = $1`, res.BatchID).Scan(&refunded, &reversed); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(),
		`SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&refundBatch); err != nil {
		t.Fatal(err)
	}
	if refunded != 4_000 || reversed != 100 || refundBatch == nil || *refundBatch != res.BatchID {
		t.Errorf("batch refunded=%d reversed=%d, refund batch=%v; want 4000, 100, %s", refunded, reversed, refundBatch, res.BatchID)
	}
}

func TestCloseBatch_RefundLargerThanDayCarriesToNextBatch(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	day1 := time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 3, 12, 0, 0, 0, 0, time.UTC)
	ast := time.FixedZone("AST", 3*3600)

	bigTxn, _ := insertCaptureEvent(t, pool, merchantID, 250, money.Fils(2_000), time.Date(2026, 3, 1, 9, 0, 0, 0, ast))
	_, fee1 := insertCaptureEvent(t, pool, merchantID, 250, money.Fils(1_000), time.Date(2026, 3, 11, 9, 0, 0, 0, ast))
	insertRefund(t, pool, merchantID, bigTxn, 2_000, 50, time.Date(2026, 3, 11, 10, 0, 0, 0, ast))

	res1, err := CloseBatch(context.Background(), pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if res1.NetPayoutFils != money.Fils(1_000)-fee1 {
		t.Errorf("day1 net = %d, want %d (refund of 1950 net would make it negative, so it waits)", res1.NetPayoutFils, money.Fils(1_000)-fee1)
	}

	_, fee2 := insertCaptureEvent(t, pool, merchantID, 250, money.Fils(5_000), time.Date(2026, 3, 12, 9, 0, 0, 0, ast))
	res2, err := CloseBatch(context.Background(), pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if want := money.Fils(5_000) - fee2 - 2_000 + 50; res2.NetPayoutFils != want {
		t.Errorf("day2 net = %d, want %d (carried refund deducted)", res2.NetPayoutFils, want)
	}
}
