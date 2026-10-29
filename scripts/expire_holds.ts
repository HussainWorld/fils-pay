#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits in
 * the table past its expires_at forever (authorize.ts inserts one,
 * capture.ts/void.ts release one; nothing else sweeps one). This flips such
 * holds from 'active' to 'expired'. Holds are never deleted (HANDOVER:
 * "flips active to expired with one UPDATE. Holds are never deleted").
 * Run once a night from cron/the host's own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

// FIX H-1: this was SELECT the expired ids, then DELETE FROM holds WHERE id = ANY(ids) via
// lib/sqlFilter.buildDelete. Three bugs: (1) on a night with nothing expired the id list was empty,
// buildWhere dropped the empty filter, and the statement became `DELETE FROM holds` — every hold in the
// table, captured and released ones included, was deleted; (2) holds were deleted at all, destroying the
// authorization history the handover says is never removed; (3) a hold captured between the SELECT and the
// DELETE was deleted anyway. One UPDATE re-checks status and expiry on every row it touches, atomically.
export const EXPIRE_HOLDS_SQL = `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`;

/** Marks every active hold past its expires_at as expired; returns how many changed. */
export async function expireHolds(client: Pick<Client, "query">): Promise<number> {
  const result = await client.query(EXPIRE_HOLDS_SQL);
  return result.rowCount ?? 0;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expired = await expireHolds(client);
    console.log(`expire_holds: marked ${expired} abandoned hold(s) expired`);
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
