-- No implicit publication/backfill of mutable drafts. Existing desired revisions
-- and the browser's monotonic assignment counter are preserved.
ALTER TABLE "device_publication_states" ADD COLUMN "desired_sequence" INTEGER NOT NULL DEFAULT 0;
UPDATE "device_publication_states" SET "desired_sequence" =
  (SELECT "presentation_revision" FROM "devices" WHERE "devices"."id" = "device_publication_states"."device_id");

CREATE TABLE "publication_commands" (
  "key_hash" TEXT NOT NULL PRIMARY KEY,
  "request_hash" TEXT NOT NULL,
  "result" JSONB,
  CONSTRAINT "publication_commands_result_json" CHECK ("result" IS NULL OR json_valid("result"))
);

CREATE TRIGGER "publication_commands_completed_immutable"
BEFORE UPDATE ON "publication_commands" WHEN OLD."result" IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Completed publication commands are immutable'); END;

-- WP-16 snapshots could point at live designs and predate explicit publishing.
-- Preserve delivery identities/fences/acks, rebuild only their derived snapshot.
UPDATE "outbox_deliveries" SET "presentation" = NULL;
