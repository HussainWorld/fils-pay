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
 */
import { useState } from "react";
import { request } from "../../api/client.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
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

const REFUNDABLE_STATUSES = new Set(["captured", "partially_captured", "partially_refunded"]);

export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());

  const merchantId = me?.merchant.id;
  const remaining = txn.capturedFils - (txn.refundedFils ?? 0);
  const refundable = REFUNDABLE_STATUSES.has(txn.status) && remaining > 0;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || submitting) return;
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const trimmed = amount.trim();
      // Blank: amountFils omitted, the API refunds everything still refundable.
      const body = trimmed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: Number(trimmed) };

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": attemptKey },
        body: JSON.stringify(body),
      });

      setOpen(false);
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
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={remaining}
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAttemptKey(crypto.randomUUID()); // a different amount is a different request
                }}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(remaining)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
