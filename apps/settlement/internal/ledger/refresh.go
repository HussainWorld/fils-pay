package ledger

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RefreshBalanceCache is what the console's "Rebuild cached balances" button
// runs (internalapi). It rebuilds every merchant's cached balance from the
// ledger — the same computation as the `settlement rebuild-balances` CLI.
//
// FIX FP-203 (D-7): this used to read merchant_payable_position, a view summing the *truncated scheme
// export lines* of closed batches (abandoned migration 0054). That is not what a merchant is owed: it
// ignores fees, unbatched captures, refunds and adjustments, and truncates every line to 10 fils. Pressing
// the button moved Alpha Retail from 135K to 7K, while the CLI (ledger) gave the right number. HANDOVER:
// "there shouldn't be one that reads anything else". Both paths now share the ledger rebuild.
func RefreshBalanceCache(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	return RebuildAllBalances(ctx, db)
}
