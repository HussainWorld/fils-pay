/**
 * FP-300: the refund control on the transaction page, wired to
 * `POST /v1/merchants/:merchantId/refunds`.
 *
 * Changes from the parked draft (it was commented out):
 * - offered for partially_refunded transactions too, and only while
 *   something is still refundable (captured - refunded > 0);
 * - the maximum is what is still refundable, not the captured total;
 * - one Idempotency-Key per refund *attempt*, kept across a double-click or
 *   a network retry and only replaced after a success or an amount change.
 *   The draft made a fresh key per click, so a double-click could send two
 *   refunds that both succeed (two partial refunds are both valid).
 * The server is still the authority: it re-validates amount, ownership and
 * role (owner/finance) whatever this form allows.
 *
 * The amount is typed in BHD (`bhdInputToFils`, i.e. `parseBhdToFils`) and a
 * refund is two steps: enter the amount, then review it on the page and
 * confirm. That review replaces a `window.confirm`, which showed no amount.
 */
import { useState } from "react";
import { request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd, bhdInputToFils } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES = new Set([
  "captured",
  "partially_captured",
  "partially_refunded",
]);

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [step, setStep] = useState<"closed" | "amount" | "review">("closed");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  const merchantId = me?.merchant.id;
  const remaining = txn.capturedFils - (txn.refundedFils ?? 0);
  const refundable = REFUNDABLE_STATUSES.has(txn.status) && remaining > 0;

  // Blank: the full remainder (amountFils omitted, the API refunds everything still refundable).
  const amountFils = amount.trim() === "" ? remaining : bhdInputToFils(amount);

  function handleReview(event: React.FormEvent): void {
    event.preventDefault();
    setError(null);
    if (amountFils === null) {
      setError("Enter a BHD amount with at most 3 decimals, e.g. 4.750.");
      return;
    }
    if (amountFils > remaining) {
      setError(`At most ${bhd(remaining)} is still refundable.`);
      return;
    }
    setStep("review");
  }

  async function handleRefund(): Promise<void> {
    if (!merchantId || submitting || amountFils === null) return;

    setSubmitting(true);
    setError(null);
    try {
      const body =
        amount.trim() === ""
          ? { transactionId: txn.id }
          : { transactionId: txn.id, amountFils };

      await request<RefundResponse>(
        `/v1/merchants/${encodeURIComponent(merchantId)}/refunds`,
        {
          method: "POST",
          headers: { "Idempotency-Key": attemptKey },
          body: JSON.stringify(body),
        },
      );

      setStep("closed");
      setAmount("");
      setAttemptKey(crypto.randomUUID()); // next refund is a new attempt
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {step === "amount" ? (
          <form className="dash-form dash-form-inline" onSubmit={handleReview}>
            <label>
              Refund amount (BHD) — blank refunds everything still refundable
              <input
                type="text"
                inputMode="decimal"
                className="dash-input-amount"
                placeholder={bhd(remaining).replace(" BHD", "")}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAttemptKey(crypto.randomUUID()); // a different amount is a different request
                }}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(remaining)}</p>
            <button type="submit" className="dash-button dash-button-primary">
              Review refund
            </button>
            <button
              type="button"
              className="dash-button"
              onClick={() => setStep("closed")}
            >
              Cancel
            </button>
          </form>
        ) : step === "review" && amountFils !== null ? (
          <div
            className="dash-confirm"
            role="alertdialog"
            aria-labelledby="refund-review-title"
          >
            <strong id="refund-review-title">
              Refund {bhd(amountFils)} to the cardholder?
            </strong>
            <dl className="dash-dl">
              <dt>Refund</dt>
              <dd>{bhd(amountFils)}</dd>
              <dt>Still refundable after</dt>
              <dd>{bhd(remaining - amountFils)}</dd>
            </dl>
            <p className="dash-muted">
              The money goes back to the card and cannot be recalled. The fee
              returned to you is worked out by the server and shown on the
              timeline.
            </p>
            <div className="dash-actions">
              <button
                type="button"
                className="dash-button dash-button-primary"
                disabled={submitting}
                onClick={() => void handleRefund()}
              >
                {submitting ? "Refunding..." : `Refund ${bhd(amountFils)}`}
              </button>
              <button
                type="button"
                className="dash-button"
                disabled={submitting}
                onClick={() => setStep("amount")}
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="dash-button"
            onClick={() => setStep("amount")}
          >
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
