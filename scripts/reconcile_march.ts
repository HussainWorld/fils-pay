#!/usr/bin/env -S npx tsx
/**
 * One-off March 2026 reconciliation sweep. Finance wants the scheme
 * rounding residue (the gap between what gets journaled at capture and
 * what the scheme export can actually carry at 2 decimal places) written
 * off for March before the books close on it. Run manually, once — see
 * scripts/out/reconcile-2026-03.log for the last real run's output.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

// FIX (window): this used the UTC calendar month. March's scheme lines come
// from batches, and batches are Asia/Bahrain business days (ARCHITECTURE,
// HANDOVER: "must use the Bahrain month, not a UTC month"). A UTC window
// misses Bahrain 1 March 00:00-03:00 (still 28 Feb in UTC) and wrongly takes
// Bahrain 1 April 00:00-03:00. Bahrain is fixed UTC+3 with no DST, so the
// Bahrain month is the UTC month shifted back 3 hours.
const BAHRAIN_OFFSET_MS = 3 * 60 * 60 * 1000;
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BAHRAIN_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BAHRAIN_OFFSET_MS),
  };
}

const SWEEP_DESCRIPTION = "March 2026 scheme rounding residue sweep — manual recon per finance";

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when a captured amount is quantized down to the
 *  scheme export's 2-decimal-place granularity. */
// MK: % 10 on a non-negative int. correct.
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

async function fetchResidueRows(client: Client, year: number, month: number): Promise<ResidueRow[]> {
  const { start, end } = monthBounds(year, month);
  const result = await client.query<{ merchant_id: string; captured_fils: string }>(
    `SELECT merchant_id, captured_fils
       FROM transactions
      WHERE captured_fils > 0
        AND captured_fils % 10 <> 0
        AND occurred_at >= $1 AND occurred_at < $2
      ORDER BY merchant_id, occurred_at`,
    [start.toISOString(), end.toISOString()],
  );
  return result.rows.map((r) => ({ merchantId: r.merchant_id, capturedFils: Number(r.captured_fils) }));
}

/**
 * One correction group per merchant. lineCount is the number of transactions
 * with a non-zero residue, not the number of scheme lines.
 */
function groupByMerchant(rows: ResidueRow[]): MerchantResidue[] {
  const byMerchant = new Map<string, MerchantResidue>();
  for (const row of rows) {
    const residue = computeResidueFils(row.capturedFils);
    const existing = byMerchant.get(row.merchantId);
    if (existing) {
      existing.lineCount += 1;
      existing.residueFils += residue;
    } else {
      byMerchant.set(row.merchantId, { merchantId: row.merchantId, lineCount: 1, residueFils: residue });
    }
  }
  return [...byMerchant.values()];
}

// FIX (legs): the residue was taken out of the merchant (debit
// merchant_payable), so every sweep lowered what we owe merchants for a
// rounding gap that is between us and the scheme. ADR-0002 defines the
// posting: credit card_scheme_clearing (the scheme pays us less than the
// gross we booked at capture), debit scheme_rounding_residue (suspense that
// finance clears against the scheme statement). The merchant is not touched.
async function postResidueCorrection(client: Client, merchant: MerchantResidue, now: Date): Promise<void> {
  if (merchant.residueFils <= 0) return;
  const entryGroupId = randomUUID(); // a fresh id every run: this never deduplicated anything
  await client.query(
    `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
     VALUES ($1, $2, 'scheme_rounding_residue', 'debit', $3, $4, $5),
            ($1, $2, 'card_scheme_clearing', 'credit', $3, $4, $5)`,
    [entryGroupId, merchant.merchantId, merchant.residueFils, now.toISOString(), SWEEP_DESCRIPTION],
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  // FH: the log says 'run at ...+03:00' but toISOString is always Z?? MK: different node version
  const now = new Date();

  try {
    const rows = await fetchResidueRows(client, 2026, 3);
    const merchantResidues = groupByMerchant(rows);
    const totalResidueFils = merchantResidues.reduce((sum, m) => sum + m.residueFils, 0);

    const { start, end } = monthBounds(2026, 3);
    console.log("=== March 2026 reconciliation sweep ===");
    console.log(`run at: ${now.toISOString()}`);
    console.log(`window: ${start.toISOString().slice(0, 10)} .. ${end.toISOString().slice(0, 10)}`);
    console.log("");

    await client.query("BEGIN");
    try {
      // FIX (finance memo: "ran it twice and the gap doubled"): nothing
      // stopped a second run. The "entry_group_id dedupes it" note was
      // wrong, since the id is a new random UUID per run. Now: take a
      // transaction-scoped advisory lock (two concurrent runs serialize) and
      // stop if this sweep's entries already exist, so running it again is a
      // no-op instead of a second posting.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('reconcile_march_2026_03'))`);
      const already = await client.query(`SELECT 1 FROM ledger_entries WHERE description = $1 LIMIT 1`, [
        SWEEP_DESCRIPTION,
      ]);
      if (already.rowCount !== 0) {
        await client.query("ROLLBACK");
        console.log("already applied: March 2026 sweep entries exist, nothing posted");
        return;
      }
      for (const merchant of merchantResidues) {
        await postResidueCorrection(client, merchant, now);
        console.log(
          `merchant ${merchant.merchantId}: ${merchant.lineCount} line(s), residue ${formatBhd(toFils(merchant.residueFils))} BD (${merchant.residueFils} fils)`,
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    console.log("---");
    console.log(`total lines matched: ${rows.length}`);
    console.log(`total residue swept: ${formatBhd(toFils(totalResidueFils))} BD (${totalResidueFils} fils)`);
    console.log("");
    console.log("reconciliation applied successfully");
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
