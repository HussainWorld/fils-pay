-- FIX A-1 ("guard against importing the same file twice", finance/eng 2026-07-08; FH 14/8: "nothing here
-- stops the same CSV being applied twice"): applying a finance adjustment sheet posts every row to the
-- ledger and the balance cache. Uploading the same sheet again (double-click, retry after a timeout,
-- two people working the same email) posted every adjustment a second time. The code comment
-- "re-upload is blocked by the unique original_filename" was wrong: there is no such constraint, and a
-- filename would not identify the content anyway.
--
-- Each import now stores a SHA-256 fingerprint of its rows, and a unique index makes the database
-- reject a second import with identical content, including two uploads racing each other.
-- Fingerprint = sha256 of the rows in order, one line each: merchant_id <TAB> raw amount text <TAB> reason
-- (computed identically in apps/api/src/admin/adjustmentImport.ts).
ALTER TABLE adjustment_imports ADD COLUMN content_sha256 TEXT;

-- Backfill from the rows already stored, so re-uploading a sheet applied before this fix is caught too.
UPDATE adjustment_imports ai
   SET content_sha256 = (
         SELECT encode(digest(string_agg(r.merchant_id::text || E'\t' || r.raw_amount_text || E'\t' || COALESCE(r.reason, ''),
                                         E'\n' ORDER BY r.row_number), 'sha256'), 'hex')
           FROM adjustment_import_rows r
          WHERE r.adjustment_import_id = ai.id);

-- Duplicates already applied before this fix are history (and evidence of the bug): keep the earliest
-- fingerprinted, leave later copies NULL so the unique index can be built.
UPDATE adjustment_imports a
   SET content_sha256 = NULL
  FROM adjustment_imports b
 WHERE a.content_sha256 = b.content_sha256
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_adjustment_imports_content_sha256
    ON adjustment_imports (content_sha256)
 WHERE content_sha256 IS NOT NULL;
