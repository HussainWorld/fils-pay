import { parseBhdToFils, type Fils } from "@filspay/money";
import { BadRequestError } from "../lib/errors.js";

/** Parses one CSV row's amount column into fils. */
export function parseAdjustmentAmountFils(raw: string): Fils {
  try {
    // FIX (finance memo: "4.755 BD imported as 0.475"): this used
    // parseDecimalMinor(raw), whose default is 2 decimals ("cents"). It cut
    // the fraction to 2 digits and glued it on, so "4.755" became "4"+"75"
    // = 475 fils (0.475 BD, 10x too small, third decimal silently dropped).
    // BD has 3 decimals (1 BD = 1000 fils). ADR-0001 rule 3 says CSV text
    // must go through parseBhdToFils, which scales by 1000 exactly and
    // rejects >3 decimals instead of truncating them.
    return parseBhdToFils(raw);
  } catch {
    throw new BadRequestError("invalid_amount", `could not parse amount "${raw}"`);
  }
}

export interface ParsedAdjustmentCsvRow {
  merchantId: string;
  amount: string;
  reason?: string;
}

/**
 * Splits the uploaded CSV text into rows. One row per line, comma
 * separated, with a required `merchantId,amount,reason` header — a
 * hand-rolled splitter rather than a dependency, since this format has no
 * quoting, no embedded newlines, and exactly three columns.
 */
export function parseAdjustmentCsv(csvContent: string): ParsedAdjustmentCsvRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  const header = (lines[0] as string).split(",").map((cell) => cell.trim().toLowerCase());
  if (header[0] !== "merchantid" || header[1] !== "amount") {
    throw new BadRequestError("invalid_csv_header", "the CSV header must be merchantId,amount,reason");
  }

  const rows: ParsedAdjustmentCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] as string).split(",").map((cell) => cell.trim());
    const merchantId = cells[0] ?? "";
    const amount = cells[1] ?? "";
    if (merchantId === "" || amount === "") {
      throw new BadRequestError("invalid_csv_row", `row ${i} is missing a merchantId or an amount`);
    }
    const reason = cells[2];
    rows.push(reason === undefined || reason === "" ? { merchantId, amount } : { merchantId, amount, reason });
  }

  if (rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain a header row and at least one data row");
  }

  return rows;
}
