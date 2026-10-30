import assert from "node:assert/strict";
import test from "node:test";
import { addDays, bahrainToday, bhdInputToFils, dayLabel, dayRangeLabel } from "./format.js";

test("bhdInputToFils reads typed BHD as integer fils via parseBhdToFils", () => {
  assert.equal(bhdInputToFils("4.75"), 4750);
  assert.equal(bhdInputToFils("4.750"), 4750);
  assert.equal(bhdInputToFils("4.755"), 4755);
  assert.equal(bhdInputToFils(" 12 "), 12000);
  assert.equal(bhdInputToFils("1,250.500"), 1250500);
  assert.equal(bhdInputToFils("0.001"), 1);
});

test("bhdInputToFils rejects zero, negatives, sub-fil precision and junk", () => {
  for (const bad of ["", "0", "0.000", "-1", "4.7555", "abc", "1e3", "4."]) {
    assert.equal(bhdInputToFils(bad), null, bad);
  }
});

test("bahrainToday is the UTC+3 calendar day", () => {
  assert.equal(bahrainToday(Date.parse("2026-10-29T20:59:00Z")), "2026-10-29");
  assert.equal(bahrainToday(Date.parse("2026-10-29T21:00:00Z")), "2026-10-30");
});

test("addDays crosses month and year ends", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("dayRangeLabel shows the inclusive last day of an exclusive range", () => {
  assert.equal(dayRangeLabel("2026-10-29", "2026-10-31", "2026"), "29 Oct – 30 Oct");
  assert.equal(dayRangeLabel("2026-10-30", "2026-10-31", "2026"), "30 Oct");
  assert.equal(dayRangeLabel("2026-10-29", "", "2026"), "From 29 Oct");
  assert.equal(dayRangeLabel("", "2026-10-31", "2026"), "Before 31 Oct");
  assert.equal(dayRangeLabel("", "", "2026"), "Any time");
  assert.equal(dayLabel("2025-12-31", "2026"), "31 Dec 2025");
});
