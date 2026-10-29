import { Readable } from "node:stream";
import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

// FIX (note: "has anyone tried a really large export?"): the export route
// used buildTransactionsExportCsv, which ran ONE unbounded
// `SELECT * ... ORDER BY occurred_at` and joined every row into a single
// string in memory, then sent it. A large merchant's full history (hundreds
// of thousands of rows, row objects + CSV copy) blows through the API's
// 512 MB container and the process is OOM-killed, taking every other
// request down with it. (CHANGELOG 1.8.0 claims it "streams"; it did not.)
// Now rows are read in fixed-size keyset pages and streamed to the client.
//
// The old streaming helper below was also wrong: it paged on occurred_at
// alone with `occurred_at > cursor`, so rows sharing the timestamp of a page
// boundary were silently dropped. Keyset on (occurred_at, id) instead.
const PAGE_SIZE = 1000;

async function* exportCsvLines(pool: Pool, filters: TransactionsExportFilters): AsyncGenerator<string> {
  yield "id,status,amount_bhd,captured_bhd,reference,occurred_at";
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: Date; id: string } | null = null;
  for (;;) {
    const result: { rows: TransactionRow[] } = await pool.query<TransactionRow>(
      `SELECT * FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        PAGE_SIZE,
      ],
    );
    for (const row of result.rows) yield toCsvRow(row);
    if (result.rows.length < PAGE_SIZE) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.occurred_at, id: last.id };
  }
}

/** Builds the whole CSV body in memory. Kept for small callers/tests only;
 *  the HTTP route streams via {@link transactionsExportStream}. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  const lines: string[] = [];
  for await (const line of exportCsvLines(pool, filters)) lines.push(line);
  return lines.join("\n");
}

/** The same CSV, byte for byte, as a stream (one page in memory at a time). */
export function transactionsExportStream(pool: Pool, filters: TransactionsExportFilters): Readable {
  return Readable.from(
    (async function* () {
      let first = true;
      for await (const line of exportCsvLines(pool, filters)) {
        yield first ? line : `\n${line}`;
        first = false;
      }
    })(),
    { objectMode: false },
  );
}

/** Cursor-paginated export for large date ranges. */
export async function streamTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
  write: (chunk: string) => void,
): Promise<void> {
  for await (const line of exportCsvLines(pool, filters)) write(line + "\n");
}
