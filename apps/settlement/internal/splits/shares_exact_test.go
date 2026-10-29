package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Shares must always sum to exactly the net payout, including the awkward
// splits that rounding each share alone gets wrong.
func TestChildShares_ExactForAwkwardSplits(t *testing.T) {
	cases := []struct {
		net     money.Fils
		weights []int64
		want    []money.Fils
	}{
		{1001, []int64{3333, 3333, 3334}, []money.Fils{334, 333, 334}},
		{100, []int64{3333, 3333, 3334}, []money.Fils{33, 33, 34}},
		{12_345, []int64{3333, 3333, 3334}, nil},
		{99_999, []int64{1500, 2500, 6000}, nil},
	}
	for _, tc := range cases {
		children := make([]ChildWeight, len(tc.weights))
		for i, w := range tc.weights {
			children[i] = ChildWeight{WeightBps: w}
		}
		shares := ChildShares(tc.net, children)
		var total money.Fils
		mismatch := false
		for i, s := range shares {
			total += s
			if tc.want != nil && s != tc.want[i] {
				mismatch = true
			}
		}
		if mismatch {
			t.Errorf("net %d: shares %v, want %v", tc.net, shares, tc.want)
		}
		if total != tc.net {
			t.Errorf("net %d: shares %v sum to %d", tc.net, shares, total)
		}
	}
}
