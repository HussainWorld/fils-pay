import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";
import { randomFromAlphabet } from "../lib/random.js";
import { serializePaymentLink, type PaymentLinkDto, type PaymentLinkRow } from "./serialize.js";

const TOKEN_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 22-char URL-safe token for payment link URLs. */
function randomPlinkToken(): string {
  return randomFromAlphabet(TOKEN_ALPHABET, 22);
}

export interface CreatePaymentLinkInput {
  merchantId: string;
  amountFils: number;
  reference?: string | null;
  description?: string | null;
  expiresAt: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/**
 * `POST /v1/merchants/:merchantId/payment-links` business logic. Single
 * `INSERT`, no transaction needed — one statement. Every validation
 * failure is a real `AppError` subclass, never an unguarded `toFils()`
 * `RangeError` escaping into a `500`.
 */
export async function createPaymentLink(
  pool: Pool,
  config: { checkoutBaseUrl: string },
  input: CreatePaymentLinkInput,
): Promise<PaymentLinkDto> {
  let amountFils;
  try {
    amountFils = toFils(input.amountFils);
  } catch (err) {
    throw new BadRequestError("invalid_amount", err instanceof Error ? err.message : String(err));
  }

  // FIX TZ-2: a zone-less value ("2026-12-31T23:59") was parsed by `new Date` in the SERVER's timezone (UTC
  // in the container), so a merchant's 23:59 Bahrain expiry became 02:59 the next morning, 3 hours late.
  // The written time is only trustworthy with its offset: require Z or ±hh:mm (the dashboard sends Z).
  if (typeof input.expiresAt !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(input.expiresAt.trim())) {
    throw new BadRequestError("invalid_expiry", "expiresAt must be an ISO 8601 date-time with a timezone (Z or +03:00)");
  }
  const expiresAtDate = new Date(input.expiresAt);
  if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
    throw new BadRequestError("invalid_expiry", "expiresAt must be a valid ISO 8601 date strictly in the future");
  }

  const token = `plink_${randomPlinkToken()}`;

  const result = await pool.query<PaymentLinkRow>(
    `INSERT INTO payment_links
        (merchant_id, token, amount_fils, reference, description, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.merchantId,
      token,
      amountFils,
      input.reference ?? null,
      input.description ?? null,
      expiresAtDate,
      input.createdByType,
      input.createdById,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createPaymentLink: insert into payment_links returned no row");
  }

  return serializePaymentLink(row, config.checkoutBaseUrl);
}
