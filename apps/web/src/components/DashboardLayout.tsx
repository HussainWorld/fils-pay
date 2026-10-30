import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="dash-shell">
      <header className="dash-header">
        <div className="dash-brand">
          <span className="dash-logo" aria-hidden="true" />
          FilsPay
        </div>
        <nav className="dash-nav" aria-label="Dashboard">
          <NavLink to="/dashboard/overview">
            <NavIcon d="M4 13h4v7H4zM10 4h4v16h-4zM16 9h4v11h-4z" />
            Overview
          </NavLink>
          <NavLink to="/dashboard/transactions">
            <NavIcon d="M4 7h13l-3-3M20 17H7l3 3" />
            Transactions
          </NavLink>
          <NavLink to="/dashboard/payment-links">
            <NavIcon d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            Payment links
          </NavLink>
          <NavLink to="/dashboard/settlement">
            <NavIcon d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18" />
            Settlement
          </NavLink>
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">
              <NavIcon d="M9 11l3 3 8-8M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11" />
              Reconciliation
            </NavLink>
          </RequireRole>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/webhooks">
              <NavIcon d="M6 14a3 3 0 1 0 3 3h6M12 9a3 3 0 1 0-3-3l3 6M18 14a3 3 0 1 0-1.5 5.6L13 12" />
              Webhooks
            </NavLink>
          </RequireRole>
        </nav>
        <div className="dash-identity">
          {me ? (
            <span>
              <strong>{me.merchant.displayName}</strong>
              {me.email}
              <span className="dash-role-chip">{me.role}</span>
            </span>
          ) : null}
          <button
            type="button"
            className="dash-button"
            onClick={() => void handleSignOut()}
          >
            Log out
          </button>
        </div>
      </header>

      <div className="dash-body">
        {error ? <p className="dash-error">{error}</p> : null}

        <main className="dash-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Stroke icon for the sidebar; decorative, the link text names the page. */
function NavIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
