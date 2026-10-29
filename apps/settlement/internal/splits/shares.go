package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights.
//
// FIX (finance memo: "split payouts short by tens of fils"): each child was
// computed on its own with ApplyRateFils(netPayout, weight), which rounds
// every share independently. The rounding never sums back to the total
// (e.g. 1001 fils over 3333/3333/3334 bps gives 334+334+334 = 1002, and
// 100 over three thirds gives 33+33+33 = 99), so fils were lost or invented
// on every split batch. Now: floor every share, then hand the leftover fils
// out one at a time by largest remainder (ties to the lower index), the same
// rule as allocateRemainder in packages/money. Shares always sum to exactly
// netPayout.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	var weightSum int64
	for _, c := range children {
		weightSum += c.WeightBps
	}
	if len(children) == 0 || weightSum <= 0 {
		return out
	}
	remainders := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(product / weightSum)
		remainders[i] = product % weightSum
		allocated += int64(out[i])
	}
	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := 0; int64(netPayout)-allocated > 0; k++ {
		out[order[k%len(order)]]++
		allocated++
	}
	return out
}
