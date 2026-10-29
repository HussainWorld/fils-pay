package settlement

import "github.com/filspay/settlement/internal/money"

// NetPayableFils derives the net payout from frozen gross and fee totals.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	// FIX R-17: was float32 BD arithmetic. float32 has a 24-bit mantissa, so above ~16,777 BD a day the
	// payout was rounded to the wrong fils (ADR-0001: float on money is a review blocker). Integer fils.
	return grossFils - feeFils
}
