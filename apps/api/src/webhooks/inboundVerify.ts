import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

/** There is no timestamp reason: freshness is not checked for inbound callbacks. */
export type VerifyAcquirerCallbackFailureReason = "malformed_header" | "signature_mismatch";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

// FIX (FP-240, "the incoming signature check has its own problems"):
// Buffer.compare is an ordinary memcmp-style comparison that stops at the
// first differing byte, so response time leaks how much of a forged
// signature is correct. Use crypto.timingSafeEqual (length check first,
// since it throws on unequal lengths; the length of a hex sha256 is public).
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Verifies the acquirer callback signature when present and required. */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = false,
): VerifyAcquirerCallbackResult {
  // FIX (FP-240): with no header at all this returned { valid: true }
  // unless ACQUIRER_CALLBACK_REQUIRE_SIGNATURE was set, and it defaults to
  // false. So anyone could POST an unsigned fake fraud verdict for any
  // transaction: the check only ran for callers polite enough to sign.
  // The signature is this public endpoint's ONLY authentication, so a
  // missing signature is always rejected. (requireSignature is kept for
  // call-site compatibility but can no longer switch the check off.)
  void requireSignature;
  if (!header) {
    return { valid: false, reason: "malformed_header" };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  // FIX (FP-240): the HMAC was computed over JSON.stringify(payload), i.e.
  // a re-serialization of the already-parsed body, not the bytes the
  // acquirer actually signed. Any difference in whitespace, key order or
  // number/unicode formatting makes a genuine callback fail. The route now
  // passes the raw request body string, which is verified as-is.
  const signedBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${signedBody}`)
    .digest("hex");

  if (!constantTimeEquals(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}
