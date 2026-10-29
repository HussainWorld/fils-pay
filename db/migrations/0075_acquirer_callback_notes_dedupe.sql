-- FIX (FP-201, reopened: "the bank sent the same callback twice and we saved
-- two identical notes"): 1.9.0 claimed callbacks were deduplicated, but
-- nothing enforced it: no unique key on callback_id and a plain INSERT.
-- Remove the duplicates already stored (keep the earliest), then make
-- callback_id unique so the database itself rejects a redelivery, even
-- when two deliveries arrive at the same moment.
DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback_id
    ON acquirer_callback_notes (callback_id);
