/** Regression for the finance memo: CSV amounts are BD with 3 decimals. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

test("CSV amounts are parsed as BD with 3 decimals (1 BD = 1000 fils)", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4_755); // was 475
  assert.equal(parseAdjustmentAmountFils("4.750"), 4_750);
  assert.equal(parseAdjustmentAmountFils("4.75"), 4_750);
  assert.equal(parseAdjustmentAmountFils("-1.25"), -1_250);
});

test("more than 3 decimals is rejected, not silently truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});
