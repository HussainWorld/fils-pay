package settlement

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// UpdateLifetimePayoutMonitoringEstimate maintains the ops dashboard
// running payout total on the merchant row. Not payout-affecting.
func UpdateLifetimePayoutMonitoringEstimate(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID, netPayoutFils money.Fils) error {
	_, err := tx.Exec(ctx, `
		UPDATE merchants
		   SET lifetime_net_payout_monitoring_estimate = lifetime_net_payout_monitoring_estimate + $2
		 WHERE id = $1
	`, merchantID, int64(netPayoutFils))
	// FIX: was float32(netPayoutFils) into a REAL column, which silently
	// loses fils once the running total passes 2^24 (see migration 0073).
	return err
}

// FIX C-2: EstimateMonthlyPayout was removed: it summed net payouts in float32 (24-bit mantissa, wrong
// above ~16,777 BD, the same drift AUDIT-FIXES #9 fixed for the lifetime estimate) and nothing called it.
