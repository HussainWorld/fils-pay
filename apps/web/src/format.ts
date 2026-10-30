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

const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Today's Asia/Bahrain business day as YYYY-MM-DD (UTC+3, no DST), whatever the browser's zone. */
export function bahrainToday(now: number = Date.now()): string {
  return new Date(now + BAHRAIN_OFFSET_MS).toISOString().slice(0, 10);
}

/** A YYYY-MM-DD day moved by `days` calendar days. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "29 Oct", or "29 Oct 2025" outside `currentYear`. */
export function dayLabel(day: string, currentYear: string = bahrainToday().slice(0, 4)): string {
  const [y, m, d] = day.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}${y === currentYear ? "" : ` ${y}`}`;
}

/**
 * Human label for a filter range whose `to` is EXCLUSIVE (what the API takes), so the last day
 * shown is the one before `to`: from 29 Oct, to 31 Oct reads "29 Oct – 30 Oct".
 */
export function dayRangeLabel(from: string, to: string, currentYear?: string): string {
  const label = (d: string) => dayLabel(d, currentYear);
  if (from && to) {
    const last = addDays(to, -1);
    return last === from ? label(from) : `${label(from)} – ${label(last)}`;
  }
  if (from) return `From ${label(from)}`;
  if (to) return `Before ${label(to)}`;
  return "Any time";
}
