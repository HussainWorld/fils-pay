import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { bhd, bhdInputToFils, localDateTimeToIso } from "../../format.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is entered in BHD, the way merchants price things, and converted to
 * fils by `bhdInputToFils` (i.e. `parseBhdToFils` from @filspay/money — no
 * second parser in the browser). The fils value is shown under the field so
 * what gets sent is never a guess.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountBhd, setAmountBhd] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    const amount = bhdInputToFils(amountBhd);
    if (amount === null) {
      setError(
        "Amount must be a positive BHD amount with at most 3 decimals, e.g. 25.500.",
      );
      return;
    }
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Expiry must be a valid date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Expiry must be in the future.");
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  const previewFils = bhdInputToFils(amountBhd);

  return (
    <section>
      <h1>New payment link</h1>

      {error ? <p className="dash-error">{error}</p> : null}

      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount (BHD)
          <input
            type="text"
            inputMode="decimal"
            className="dash-input-amount"
            placeholder="25.000"
            required
            value={amountBhd}
            onChange={(e) => setAmountBhd(e.target.value)}
          />
        </label>
        <p className="dash-muted dash-hint">
          {previewFils === null
            ? "Up to 3 decimals: 1 BHD = 1,000 fils."
            : `Customer pays ${bhd(previewFils)} (${previewFils.toLocaleString("en-US")} fils).`}
        </p>
        <label>
          Reference (optional)
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <label>
          Description (optional)
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          Expires at (your local time)
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="dash-button dash-button-primary"
          disabled={submitting}
        >
          {submitting ? "Creating..." : "Create payment link"}
        </button>
      </form>

      <p>
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}
