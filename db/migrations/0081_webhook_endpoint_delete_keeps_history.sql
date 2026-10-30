-- FIX (B87): DELETE /v1/merchants/:id/webhook-endpoints/:id promised (in
-- webhooks/cancel.ts) that delivery history is kept "with endpoint_id set to
-- NULL", and a code-review note said "FK is ON DELETE SET NULL (0029)".
-- Neither was true: 0022 and 0068 declared endpoint_id NOT NULL with a plain
-- (NO ACTION) foreign key, and 0029 is an unrelated payment-links index. So
-- deleting any endpoint that had ever received a delivery failed with a
-- foreign-key violation (HTTP 500), and only never-used endpoints could be
-- deleted.
--
-- Smallest change that makes the documented behaviour true: allow NULL and
-- switch both foreign keys to ON DELETE SET NULL. The delivery and archive
-- rows stay (they still carry merchant_id, payload and timestamps); they just
-- no longer point at a registration that no longer exists. The dispatcher
-- joins on webhook_endpoints, so pending deliveries for a deleted endpoint
-- are simply never attempted again.

ALTER TABLE webhook_deliveries ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE webhook_deliveries DROP CONSTRAINT webhook_deliveries_endpoint_id_fkey;
ALTER TABLE webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_endpoint_id_fkey
    FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE SET NULL;

ALTER TABLE webhook_delivery_archives ALTER COLUMN endpoint_id DROP NOT NULL;
ALTER TABLE webhook_delivery_archives DROP CONSTRAINT webhook_delivery_archives_endpoint_id_fkey;
ALTER TABLE webhook_delivery_archives
    ADD CONSTRAINT webhook_delivery_archives_endpoint_id_fkey
    FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id) ON DELETE SET NULL;
