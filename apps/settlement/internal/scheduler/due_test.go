package scheduler

import (
	"testing"
	"time"
)

// The close for a Bahrain business day is due 15 min after Bahrain midnight
// (21:15 UTC), not after UTC midnight (03:15 Bahrain).
func TestDueBusinessDate_ClosesAfterBahrainMidnight(t *testing.T) {
	cases := []struct {
		now     time.Time
		wantDay string
		wantDue bool
	}{
		// 23:50 Bahrain on 23 Mar: 23 Mar still open, 22 Mar already closed
		{time.Date(2026, 3, 23, 20, 50, 0, 0, time.UTC), "2026-03-22", true},
		// 00:05 Bahrain on 24 Mar: inside the 15 min grace, 23 Mar not due yet
		{time.Date(2026, 3, 23, 21, 5, 0, 0, time.UTC), "2026-03-23", false},
		// 00:20 Bahrain on 24 Mar: 23 Mar is due now (was 03:15 before)
		{time.Date(2026, 3, 23, 21, 20, 0, 0, time.UTC), "2026-03-23", true},
	}
	for _, c := range cases {
		day, due := dueBusinessDate(c.now, 15)
		if day.Format("2006-01-02") != c.wantDay || due != c.wantDue {
			t.Errorf("now %s: got (%s, %v), want (%s, %v)", c.now, day.Format("2006-01-02"), due, c.wantDay, c.wantDue)
		}
	}
}
