import assert from "node:assert/strict";
import test from "node:test";
import { bhdInputToFils } from "./format.js";

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
