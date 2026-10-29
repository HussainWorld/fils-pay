package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
//
// FIX (ADR-0001: "float arithmetic on money is a review blocker"): this
// converted both totals to float32 BD, subtracted, and rounded back.
// float32 holds only ~7 significant digits, so any batch above ~16,777 BD
// (16,777,216 fils) lost fils in the conversion and the payout drifted from
// gross - fee. Both inputs are already exact integer fils, so plain integer
// subtraction is exact and is the whole calculation.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
