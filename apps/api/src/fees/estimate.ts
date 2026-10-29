import { applyRateFils, toFils } from "@filspay/money";

/** Estimated fee for a single capture: the exact settlement formula
 *  (Go ComputeSettlementFee): MDR charged on the discounted amount.
 *
 *  FIX (ADR-0001): this used float rates (amount * mdr/10000, Math.round),
 *  and discounted the FEE rather than the amount, so the reconciliation
 *  "pending" figure could differ from what CloseBatch later charges by a
 *  fil per capture and the report showed an unexplained gap. */
export function estimateFeeFils(
  amountFils: number,
  mdrBps: number,
  discountBps: number,
): number {
  const amount = toFils(amountFils);
  const discounted = toFils(amount - applyRateFils(amount, discountBps));
  return applyRateFils(discounted, mdrBps);
}
