package scheduler

import (
	"testing"
	"time"
)

// B55: the documented nightly balance refresh runs once per Bahrain day, at
// or after 02:00 Bahrain (23:00 UTC the previous evening), never before.
func TestBalanceRefreshDue_0200BahrainOncePerDay(t *testing.T) {
	never := time.Time{}
	day24 := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name    string
		now     time.Time
		last    time.Time
		wantDue bool
	}{
		{"01:59 Bahrain 24 Mar: too early", time.Date(2026, 3, 23, 22, 59, 0, 0, time.UTC), never, false},
		{"02:00 Bahrain 24 Mar: due", time.Date(2026, 3, 23, 23, 0, 0, 0, time.UTC), never, true},
		{"02:00 UTC would be 05:00 Bahrain: due, not later", time.Date(2026, 3, 24, 2, 0, 0, 0, time.UTC), never, true},
		{"already ran today", time.Date(2026, 3, 24, 9, 0, 0, 0, time.UTC), day24, false},
		{"ran yesterday, due again after 02:00", time.Date(2026, 3, 24, 23, 30, 0, 0, time.UTC), day24, true},
	}
	for _, c := range cases {
		if _, due := balanceRefreshDue(c.now, c.last); due != c.wantDue {
			t.Errorf("%s: due=%v, want %v", c.name, due, c.wantDue)
		}
	}
}
