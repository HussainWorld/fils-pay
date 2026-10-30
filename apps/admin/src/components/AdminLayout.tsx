import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="admin-shell">
      <ImpersonationBanner />

      <header className="admin-header">
        <div className="admin-brand">
          <span className="admin-logo" aria-hidden="true" />
          FilsPay
          <span className="admin-tag">Ops</span>
        </div>
        <nav className="admin-nav" aria-label="Ops console">
          <NavLink to="/merchants">
            <NavIcon d="M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6" />
            Merchants
          </NavLink>
          <NavLink to="/credits">
            <NavIcon d="M12 3v18M17 7H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6" />
            Credits
          </NavLink>
          <NavLink to="/settlement">
            <NavIcon d="M3 10l9-6 9 6M5 10v8M10 10v8M14 10v8M19 10v8M3 21h18" />
            Settlement ops
          </NavLink>
          <NavLink to="/adjustment-imports">
            <NavIcon d="M12 16V4M7 9l5-5 5 5M5 20h14" />
            Import adjustments
          </NavLink>
          <NavLink to="/webhooks">
            <NavIcon d="M6 14a3 3 0 1 0 3 3h6M12 9a3 3 0 1 0-3-3l3 6M18 14a3 3 0 1 0-1.5 5.6L13 12" />
            Webhook replay
          </NavLink>
        </nav>
        <div className="admin-identity">
          {admin ? (
            <span>
              {admin.email}
              <span className="admin-role-chip">{admin.role}</span>
            </span>
          ) : null}
          <button type="button" onClick={() => void handleSignOut()}>
            Log out
          </button>
        </div>
      </header>

      <div className="admin-body">
        {error ? <p className="admin-error">{error}</p> : null}

        {impersonation ? (
          // An explicit "exit view-as-merchant" action is required before
          // admin-plane screens are shown again. This is a UX safeguard so the
          // two modes are never confused on screen; the privilege boundary
          // itself does not depend on it — /v1/admin/* never reads the
          // impersonation cookie, and the merchant side never reads the admin
          // session cookie.
          <main className="admin-main">
            <h1>Admin screens are paused</h1>
            <p>
              An impersonation grant is active. Use{" "}
              <strong>Exit impersonation</strong> above to end it and return to
              the admin console.
            </p>
            <p>
              Merchant screens are at <code>{WEB_BASE_URL}</code> while the
              grant lasts.
            </p>
          </main>
        ) : (
          <main className="admin-main">
            <Outlet />
          </main>
        )}
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
