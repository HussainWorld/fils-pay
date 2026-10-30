import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/** Refund business logic: validate, call the acquirer, then journal the reversal. */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  // FIX (FP-209 "two refund requests at the same time both went through"):
  // the refund ran as three separate steps: (1) read + validate in one
  // transaction with NO row lock, (2) call the acquirer outside any
  // transaction, (3) journal in a second transaction, writing
  // refunded_fils = <value read in step 1> + amount. Two concurrent
  // requests both read refunded_fils = 0, both passed validation, the
  // acquirer paid out twice, and the second write even overwrote the first
  // (lost update), so the ledger did not show it. capture.ts does not have
  // this problem because it holds SELECT ... FOR UPDATE on the transaction
  // row for the whole flow, acquirer call included. Refunds now do the same:
  // one transaction, row locked from validation to journal, so a concurrent
  // refund waits and then validates against the updated refunded_fils.
  return withTransaction(pool, async (client) => {
  // 1 validate
  const prepared = await (async () => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });

    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return {
        kind: "settled" as const,
        result: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody },
      };
    }

    // FIX: lock the row (see above) and scope it to the caller's merchant.
    // It was `WHERE id = $1` only, so any merchant could refund any other
    // merchant's transaction by id (IDOR) and debit that merchant's payable.
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { kind: "settled" as const, result: { statusCode: 404, body } };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));

    // FIX (note: "can you refund more than what was actually charged?"):
    // this was amountAuthorized - refundedFils. On a partial capture (auth
    // 10.000, captured 4.000) a merchant could refund up to 10.000 BD, i.e.
    // 6.000 BD that was never taken from the card. Only captured money can
    // go back.
    const refundableFils = subtractFils(capturedFils, refundedFils);

    const validation = validateRefundRequest(
      {
        id: txn.id,
        merchantId: txn.merchant_id,
        status: txn.status,
        capturedFils,
        refundableFils,
      },
      input.amountFils,
    );

    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { kind: "settled" as const, result: { statusCode, body: validation } };
    }

    // The fee this transaction was actually charged at capture, read from
    // the ledger rather than recomputed from the merchant's current
    // mdr_bps, so a rate change after capture can never retroactively alter
    // what a refund reverses.
    // FP-300: the NET fee charged = capture fee credits minus any legacy
    // negotiated-discount adjustments (debits posted by the old post-capture
    // discount step). Prior refund reversals are excluded on purpose: the
    // reversal below is computed cumulatively against the original fee.
    const feeResult = await client.query<{ fee_fils: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS fee_fils
         FROM ledger_entries
        WHERE transaction_id = $1
          AND account_id = 'platform_fee_revenue'
          AND (direction = 'credit' OR description = 'capture: negotiated discount adjustment')`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0];
    if (!feeRow) {
      throw new Error("processRefund: fee aggregate returned no row");
    }

    return {
      kind: "proceed" as const,
      claimId: claim.row.id,
      attemptCount: claim.row.attemptCount,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      acquirerReference: txn.acquirer_reference,
      amountAuthorized,
      capturedFils,
      refundedFils,
      feeChargedFils: toFils(Number(feeRow.fee_fils)),
      requestedAmount: validation.amountFils,
    };
  })();

  if (prepared.kind === "settled") {
    return prepared.result;
  }

  // 2 acquirer
  const acquirerResult = await acquirer.refund({
    acquirerReference: prepared.acquirerReference,
    amountFils: prepared.requestedAmount,
    idempotencyKey: `${prepared.claimId}:${prepared.attemptCount}`,
  });

  // 3 journal (same transaction, row still locked)
  return (async () => {
    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, prepared.claimId, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, prepared.claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = addFils(prepared.refundedFils, prepared.requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: prepared.amountAuthorized,
      capturedFils: prepared.capturedFils,
      refundedTotalFils: newRefundedTotal,
    });
    // FP-300: reverse the fee cumulatively. Rounding each partial refund's
    // share on its own does not sum back to the fee charged (fee 119 refunded
    // in three thirds = 40 + 40 + 40 = 120: one fil more than was ever
    // charged). Reversal = share(total refunded after) - share(before), which
    // telescopes to exactly the fee when the whole capture is refunded.
    const feeReversedFils = subtractFils(
      calculateRefundFee(prepared.capturedFils, prepared.feeChargedFils, newRefundedTotal),
      calculateRefundFee(prepared.capturedFils, prepared.feeChargedFils, prepared.refundedFils),
    );

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        prepared.transactionId,
        prepared.merchantId,
        prepared.requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        // FIX: an explicit NULL bypasses the column DEFAULT and violates
        // chk_refunds_reason_not_null (migration 0070), so every refund
        // without a reason failed after the acquirer had already paid out.
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      prepared.transactionId,
      newRefundedTotal,
      newStatus,
    ]);

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, prepared.merchantId, prepared.transactionId, prepared.requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, prepared.merchantId, prepared.transactionId, feeReversedFils],
      );
    }

    // FIX FP-203b: mirror the ledger in the cached balance: merchant_payable was just debited the refund
    // and credited back the reversed fee.
    await client.query(
      `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (merchant_id) DO UPDATE
         SET cached_payable_fils = merchant_balances.cached_payable_fils + EXCLUDED.cached_payable_fils,
             updated_at = now()`,
      [prepared.merchantId, -(prepared.requestedAmount - feeReversedFils)],
    );

    // The timeline records what this refund did to the captured amount, so
    // it stays readable regardless of what the status column ends up
    // saying: everything captured has now gone back, or only part of it has.
    const eventType = compareFils(newRefundedTotal, prepared.capturedFils) >= 0 ? "refunded" : "refund_partial";

    await recordTransactionEvent(client, {
      transactionId: prepared.transactionId,
      eventType,
      amountFils: toFils(-prepared.requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: prepared.transactionId,
      payload: {
        merchantId: prepared.merchantId,
        refundId: refund.id,
        amountFils: prepared.requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: prepared.transactionId,
      merchantId: prepared.merchantId,
      amountFils: prepared.requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, prepared.claimId, {
      statusCode: 200,
      body,
      resourceId: refund.id,
    });
    return { statusCode: 200, body };
  })();
  });
}
