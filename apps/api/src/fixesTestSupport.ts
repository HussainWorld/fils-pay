/**
 * Shared setup for the regression tests added with the audit fixes
 * (*.fix.test.ts). Same pattern as the existing route tests: a real
 * migrated Postgres via DATABASE_URL and app.inject().
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashPassword } from "./adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("fix tests require DATABASE_URL");

export const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "60",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
export const pool = new Pool({ connectionString: databaseUrl, max: 5 });
export const app = buildApp(config, pool);

export async function closeAll(): Promise<void> {
  await app.close();
  await pool.end();
}

export function parseCookie(setCookieHeader: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) return header.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

const ADMIN_PASSWORD = "admin-test-password-9000!";
export async function signedInAdmin(role: "support" | "finance" | "super_admin", label = "fix") {
  const hash = await hashPassword(ADMIN_PASSWORD, config);
  const email = `${label}-${randomUUID()}@admin.test`;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, hash, `${label} ${randomUUID().slice(0, 8)}`, role],
  );
  const loginRes = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password: ADMIN_PASSWORD } });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const cookie = parseCookie(loginRes.headers["set-cookie"], config.adminCookieName);
  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code: (loginRes.json() as { devOtpCode?: string }).devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);
  return { id: inserted.rows[0]!.id, email, cookie };
}

export async function createMerchant(label: string, opts: { testMode?: boolean } = {}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, test_mode) VALUES ($1, 250, $2) RETURNING id`,
    [`Fix Test ${label} ${randomUUID()}`, opts.testMode ?? false],
  );
  return result.rows[0]!.id;
}

export const MERCHANT_PASSWORD = "merchant-test-password-9000!";
/** An active merchant with one owner user who can log in with a password. */
export async function createLoginableMerchant(label: string, email = `${label}-${randomUUID()}@example.test`) {
  const merchantId = await createMerchant(label);
  await pool.query(`UPDATE merchants SET status = 'active' WHERE id = $1`, [merchantId]);
  const { hashPassword: hashMerchantPassword } = await import("./auth/passwords.js");
  const hash = await hashMerchantPassword(MERCHANT_PASSWORD, config);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3) RETURNING id`,
    [merchantId, email, hash],
  );
  return { merchantId, userId: user.rows[0]!.id, email };
}

/** Password step only: returns the pending cookie and the dev OTP code. */
export async function passwordStep(merchantId: string, email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password: MERCHANT_PASSWORD },
  });
  assert.equal(res.statusCode, 200, res.body);
  return {
    cookie: parseCookie(res.headers["set-cookie"], config.cookieName),
    code: (res.json() as { devOtpCode: string }).devOtpCode,
  };
}

/** Full login (password + OTP): returns an authenticated session cookie. */
export async function merchantLogin(merchantId: string, email: string): Promise<string> {
  const { cookie, code } = await passwordStep(merchantId, email);
  const res = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(res.statusCode, 200, res.body);
  return cookie;
}

/** Approved merchant with an owner user and a real API key. */
export async function createApprovedMerchantWithApiKey(label: string) {
  const { issueApiKey } = await import("./apiKeys/issue.js");
  const { recordKycReview } = await import("./onboarding/review.js");
  const merchantId = await createMerchant(label);
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, ownerUserId: user.rows[0]!.id, rawKey: issued.rawKey };
}

export const APPROVED_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

export async function createLink(rawKey: string, merchantId: string, body: { amountFils?: number; expiresAt?: string } = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${rawKey}` },
    payload: {
      amountFils: body.amountFils ?? 4_750,
      reference: "fix-test",
      description: "fix test",
      expiresAt: body.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string; status: string; expiresAt: string };
}
