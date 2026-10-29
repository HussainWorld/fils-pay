-- FIX D-7: abandoned migration (HANDOVER; ADR-0005 reserves 0054-0056). Moved out of db/migrations/ so it is never applied. See README.md.
-- Scheduled revocation: keys with revoke_after are revoked by a sweep job
-- once the timestamp passes, so rotation can be staged without immediate
-- invalidation.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoke_after timestamptz;
