import { formatBhd, parseBhdToFils, toFils } from "@filspay/money";

/**
 * The dashboard's display helpers. Deliberately thin: `bhd` delegates to
 * `@filspay/money`'s `formatBhd`, the same formatter the checkout page uses,
 * so there is exactly one answer to "how is a BHD amount shown" across both
 * halves of this app. Never `/1000`, never `toFixed`.
 */
// FH: toFils without allowNegative throws on a negative — refund events / negative gaps crash the page?
// MK: amounts are never negative in the dashboard. ignore
export function bhd(amountFils: number): string {
  // FIX (FP-300 timeline): refund events carry a NEGATIVE amountFils, and
  // toFils() rejects negatives by default, so rendering a refund on the
  // transaction timeline threw and blanked the whole page.
  return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
}

/**
 * A BHD amount typed into a form ("4.75", "4.750", "12") as positive integer fils, or null when the text
 * isn't a valid positive amount with at most 3 decimals. Parsing is `@filspay/money`'s `parseBhdToFils`,
 * the same string-to-fils path the API uses, so there is no second parser in the browser.
 */
export function bhdInputToFils(text: string): number | null {
  try {
    const fils = parseBhdToFils(text.replace(/,/g, ""));
    return fils > 0 ? fils : null;
  } catch {
    return null;
  }
}

/** `—` for a null/absent value, so an empty table cell is visibly empty
 *  rather than ambiguously blank. */
export function dash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** Browser-local rendering, not Asia/Bahrain. */
export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * An `<input type="date">` value (YYYY-MM-DD) as the ISO instant its Asia/Bahrain business day starts
 * (UTC+3, no DST) — what the `from`/`to` transaction filters take, so a day picked here is the same
 * day settlement, reconciliation and reports mean.
 */
// FIX TZ-1: this returned `${date}T00:00:00.000Z`, a UTC midnight, so filtering "29 Oct" covered 03:00
// 29 Oct to 03:00 30 Oct Bahrain time: the first three hours of the day were missing and three hours of
// the next day leaked in. The comment "fixed, uses bahrain time now — am" was never true.
export function dayStartIso(dateValue: string): string | undefined {
  return dateValue ? new Date(`${dateValue}T00:00:00+03:00`).toISOString() : undefined;
}

/**
 * A `<input type="datetime-local">` value (local wall time, no zone) as an
 * ISO 8601 instant. `new Date(local)` interprets it in the browser's own
 * timezone, which is what the user meant when they typed it.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
