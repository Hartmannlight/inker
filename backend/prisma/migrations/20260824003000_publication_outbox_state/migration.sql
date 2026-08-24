-- WP-07 adds the durable publication, delivery-intent and transactional outbox
-- boundary. Earlier migrations remain immutable.
CREATE TABLE "publications" (
    "publication_id" TEXT NOT NULL PRIMARY KEY,
    "publication_key" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "publication_revisions" (
    "publication_revision_id" TEXT NOT NULL PRIMARY KEY,
    "publication_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "protocol_version" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "published_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "publication_revisions_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications" ("publication_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "publication_revisions_revision_positive" CHECK ("revision" > 0),
    CONSTRAINT "publication_revisions_content_json" CHECK (json_valid("content"))
);

CREATE TABLE "device_publication_states" (
    "device_id" INTEGER NOT NULL PRIMARY KEY,
    "desired_publication_revision_id" TEXT,
    "acknowledged_publication_revision_id" TEXT,
    "desired_at" DATETIME,
    "acknowledged_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "device_publication_states_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_publication_states_desired_revision_fkey" FOREIGN KEY ("desired_publication_revision_id") REFERENCES "publication_revisions" ("publication_revision_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "device_publication_states_acknowledged_revision_fkey" FOREIGN KEY ("acknowledged_publication_revision_id") REFERENCES "publication_revisions" ("publication_revision_id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "outbox_events" (
    "event_id" TEXT NOT NULL PRIMARY KEY,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" DATETIME,
    "processed_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbox_events_status" CHECK ("status" IN ('pending', 'processing', 'delivered', 'dead-letter')),
    CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("attempts" >= 0),
    CONSTRAINT "outbox_events_payload_version_positive" CHECK ("payload_version" > 0),
    CONSTRAINT "outbox_events_payload_json" CHECK (json_valid("payload"))
);

CREATE UNIQUE INDEX "publications_publication_key_key" ON "publications"("publication_key");
CREATE UNIQUE INDEX "publication_revisions_publication_id_revision_key" ON "publication_revisions"("publication_id", "revision");
CREATE INDEX "publication_revisions_publication_id_published_at_idx" ON "publication_revisions"("publication_id", "published_at");
CREATE INDEX "device_publication_states_desired_publication_revision_id_idx" ON "device_publication_states"("desired_publication_revision_id");
CREATE INDEX "device_publication_states_acknowledged_publication_revision_id_idx" ON "device_publication_states"("acknowledged_publication_revision_id");
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_idx" ON "outbox_events"("aggregate_type", "aggregate_id");
CREATE INDEX "outbox_events_occurred_at_idx" ON "outbox_events"("occurred_at");

-- Publication identities and revision snapshots are append-only. Retention is
-- allowed to DELETE unreferenced rows, but no code path may rewrite history.
CREATE TRIGGER "publications_prevent_update"
BEFORE UPDATE ON "publications"
BEGIN
  SELECT RAISE(ABORT, 'publications are immutable');
END;

CREATE TRIGGER "publication_revisions_prevent_update"
BEFORE UPDATE ON "publication_revisions"
BEGIN
  SELECT RAISE(ABORT, 'publication revisions are immutable');
END;
