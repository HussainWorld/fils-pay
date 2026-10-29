/**
 * FIX K-1 regression: PDF-only KYC document types are decided by the file's
 * bytes, not by the client-chosen filename. Requires DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { recordKycDocument } from "./kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("kyc.fix.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(() => pool.end());

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");

async function setup() {
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    KYC_UPLOAD_DIR: await mkdtemp(join(tmpdir(), "kyc-fix-")),
  });
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `KYC ${randomUUID()}`,
  ]);
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `kyc-${randomUUID()}@example.test`],
  );
  return { config, merchantId, uploadedBy: u.rows[0]!.id };
}

for (const documentType of ["commercial_registration", "bank_letter"] as const) {
  test(`K-1: a JPEG renamed to .pdf is rejected for ${documentType}`, async () => {
    const { config, merchantId, uploadedBy } = await setup();
    await assert.rejects(
      recordKycDocument(pool, config, { merchantId, documentType, fileName: "CR-2026.pdf", buffer: JPEG_BYTES, uploadedBy }),
      (err: { code?: string }) => err.code === "document_must_be_pdf",
    );
    const rows = await pool.query(`SELECT 1 FROM kyc_documents WHERE merchant_id = $1`, [merchantId]);
    assert.equal(rows.rowCount, 0);
  });
}

test("K-1: a real PDF named .pdf is still accepted for a PDF-only type", async () => {
  const { config, merchantId, uploadedBy } = await setup();
  await recordKycDocument(pool, config, {
    merchantId,
    documentType: "bank_letter",
    fileName: "bank_letter.pdf",
    buffer: PDF_BYTES,
    uploadedBy,
  });
  const rows = await pool.query(`SELECT 1 FROM kyc_documents WHERE merchant_id = $1`, [merchantId]);
  assert.equal(rows.rowCount, 1);
});
