ALTER TABLE "outbox_effects" ADD COLUMN "prepared_at" DATETIME;
ALTER TABLE "outbox_effects" ADD COLUMN "progress_cursor" TEXT;

-- Before this migration OutboxStore prepared an effect and all recipients in
-- one transaction. Existing effects are therefore complete snapshots.
UPDATE "outbox_effects"
SET "prepared_at" = COALESCE("completed_at", 0);

CREATE INDEX "publication_revisions_published_at_idx"
ON "publication_revisions"("published_at");
