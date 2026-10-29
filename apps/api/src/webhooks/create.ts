import type { Pool } from "pg";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { isIP } from "node:net";
import { BadRequestError } from "../lib/errors.js";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";

/**
 * Validates a webhook endpoint URL: must parse as an absolute URL with
 * scheme http/https; https is required once config.nodeEnv === 'production'
 * (http is permitted otherwise so a local http.createServer test receiver
 * and a merchant's own localhost dev setup both work).
 */
// MK: https-only in prod is our SSRF protection
// used to block localhost in dev too, removed for the local receiver — am
export function validateWebhookUrl(rawUrl: string, config: Pick<Config, "nodeEnv">): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  // FIX (SSRF): "https-only in prod" was the whole protection, so a merchant
  // could point their webhook at https://127.0.0.1, https://10.x, the cloud
  // metadata address, or a bare compose service name (postgres, settlement),
  // and the dispatcher would POST there from inside our network and store the
  // response excerpt where the merchant can read it. In production, refuse
  // hosts that are not public. (Redirects are refused in transport.ts too.)
  if (config.nodeEnv === "production" && !isPublicHostname(parsed.hostname)) {
    throw new BadRequestError("invalid_url", "webhook URL must point to a public host");
  }
  return parsed;
}

/** True unless the host is an internal name or a loopback/private/link-local IP literal. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return false;
  }
  const kind = isIP(host);
  if (kind === 0) return host.includes("."); // a single-label name only resolves inside our network
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  // IPv6: loopback, unspecified, unique-local, link-local, IPv4-mapped
  return !(host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:"));
}

export interface CreateWebhookEndpointInput {
  merchantId: string;
  url: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/** The signing secret is returned here in plaintext once and never again. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  /** appears here and nowhere else, ever — the classic show-once pattern
   *  api_keys already uses. */
  secret: string;
}

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints` business logic.
 */
export async function createWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey">,
  input: CreateWebhookEndpointInput,
): Promise<CreatedWebhookEndpoint> {
  validateWebhookUrl(input.url, config);

  const rawSecret = `whsec_${randomToken(24)}`;
  const secretPrefix = rawSecret.slice(0, 14);
  const secretCiphertext = encryptSecret(rawSecret, decodeEncryptionKey(config.webhookSecretEncryptionKey));

  const result = await pool.query<{
    id: string;
    url: string;
    secret_prefix: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, url, secret_prefix, status, created_at`,
    [input.merchantId, input.url, secretCiphertext, secretPrefix, input.createdByType, input.createdById],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createWebhookEndpoint: insert into webhook_endpoints returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    secret: rawSecret,
  };
}
