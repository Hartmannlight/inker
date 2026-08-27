CREATE TABLE "source_secrets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ciphertext" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "source_definitions" (
  "source_definition_id" TEXT NOT NULL PRIMARY KEY,
  "definition_version" INTEGER NOT NULL DEFAULT 1 CHECK ("definition_version" > 0),
  "name" TEXT NOT NULL,
  "connector_type" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "configuration" JSONB NOT NULL,
  "secret_id" TEXT,
  "refresh_interval_seconds" INTEGER NOT NULL CHECK ("refresh_interval_seconds" BETWEEN 1 AND 86400),
  "timeout_ms" INTEGER NOT NULL CHECK ("timeout_ms" BETWEEN 50 AND 7500),
  "concurrency_group" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "next_refresh_at" DATETIME NOT NULL,
  "snapshot_revision" INTEGER NOT NULL DEFAULT 0 CHECK ("snapshot_revision" >= 0),
  "latest_snapshot_id" TEXT,
  "latest_valid_snapshot_id" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0 CHECK ("consecutive_failures" >= 0),
  "circuit_open_until" DATETIME,
  "last_attempt_at" DATETIME,
  "last_success_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "source_definitions_secret_id_fkey" FOREIGN KEY ("secret_id") REFERENCES "source_secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "source_definitions_latest_snapshot_id_fkey" FOREIGN KEY ("latest_snapshot_id") REFERENCES "source_snapshots"("snapshot_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "source_definitions_latest_valid_snapshot_id_fkey" FOREIGN KEY ("latest_valid_snapshot_id") REFERENCES "source_snapshots"("snapshot_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "source_snapshots" (
  "snapshot_id" TEXT NOT NULL PRIMARY KEY,
  "source_definition_id" TEXT NOT NULL,
  "definition_version" INTEGER NOT NULL CHECK ("definition_version" > 0),
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "protocol_version" TEXT NOT NULL DEFAULT '1.0',
  "schema_version" TEXT NOT NULL,
  "connector_version" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_timestamp" DATETIME,
  "valid_data_created_at" DATETIME,
  "freshness_state" TEXT NOT NULL CHECK ("freshness_state" IN ('fresh','stale','error')),
  "stale_after_seconds" INTEGER NOT NULL CHECK ("stale_after_seconds" > 0),
  "data" JSONB NOT NULL,
  "content_hash" TEXT NOT NULL CHECK (length("content_hash") = 64),
  "error_code" TEXT,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "refresh_event_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL CHECK ("attempt" > 0),
  CONSTRAINT "source_snapshots_source_definition_id_fkey" FOREIGN KEY ("source_definition_id") REFERENCES "source_definitions"("source_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (("freshness_state" = 'fresh' AND "error_code" IS NULL AND "valid_data_created_at" IS NOT NULL)
    OR ("freshness_state" = 'stale' AND "valid_data_created_at" IS NOT NULL)
    OR ("freshness_state" = 'error' AND "error_code" IS NOT NULL AND "valid_data_created_at" IS NULL))
);
CREATE TABLE "source_refresh_jobs" (
  "event_id" TEXT NOT NULL PRIMARY KEY,
  "source_definition_id" TEXT NOT NULL,
  "definition_version" INTEGER NOT NULL,
  "connector_type" TEXT NOT NULL,
  "concurrency_group" TEXT NOT NULL,
  "scheduled_at" DATETIME NOT NULL,
  "completed_at" DATETIME,
  CONSTRAINT "source_refresh_jobs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_events"("event_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "source_refresh_jobs_source_definition_id_fkey" FOREIGN KEY ("source_definition_id") REFERENCES "source_definitions"("source_definition_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "source_definitions_latest_snapshot_id_key" ON "source_definitions"("latest_snapshot_id");
CREATE UNIQUE INDEX "source_definitions_latest_valid_snapshot_id_key" ON "source_definitions"("latest_valid_snapshot_id");
CREATE INDEX "source_definitions_enabled_next_refresh_at_idx" ON "source_definitions"("enabled","next_refresh_at");
CREATE INDEX "source_definitions_concurrency_group_connector_type_idx" ON "source_definitions"("concurrency_group","connector_type");
CREATE UNIQUE INDEX "source_snapshots_source_definition_id_revision_key" ON "source_snapshots"("source_definition_id","revision");
CREATE UNIQUE INDEX "source_snapshots_refresh_event_id_attempt_key" ON "source_snapshots"("refresh_event_id","attempt");
CREATE INDEX "source_refresh_jobs_source_definition_id_completed_at_idx" ON "source_refresh_jobs"("source_definition_id","completed_at");
CREATE INDEX "source_refresh_jobs_concurrency_group_connector_type_idx" ON "source_refresh_jobs"("concurrency_group","connector_type");
CREATE TRIGGER source_snapshot_immutable_update BEFORE UPDATE ON source_snapshots BEGIN SELECT RAISE(ABORT, 'source_snapshot_immutable'); END;
CREATE TRIGGER source_snapshot_immutable_delete BEFORE DELETE ON source_snapshots BEGIN SELECT RAISE(ABORT, 'source_snapshot_immutable'); END;
CREATE TRIGGER source_latest_snapshot_owner BEFORE UPDATE OF latest_snapshot_id, latest_valid_snapshot_id ON source_definitions
WHEN (NEW.latest_snapshot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_snapshots WHERE snapshot_id = NEW.latest_snapshot_id AND source_definition_id = NEW.source_definition_id))
  OR (NEW.latest_valid_snapshot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_snapshots WHERE snapshot_id = NEW.latest_valid_snapshot_id AND source_definition_id = NEW.source_definition_id AND freshness_state = 'fresh'))
BEGIN SELECT RAISE(ABORT, 'source_snapshot_owner_mismatch'); END;
CREATE TRIGGER source_initial_snapshot_owner BEFORE INSERT ON source_definitions
WHEN (NEW.latest_snapshot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_snapshots WHERE snapshot_id = NEW.latest_snapshot_id AND source_definition_id = NEW.source_definition_id))
  OR (NEW.latest_valid_snapshot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM source_snapshots WHERE snapshot_id = NEW.latest_valid_snapshot_id AND source_definition_id = NEW.source_definition_id AND freshness_state = 'fresh'))
BEGIN SELECT RAISE(ABORT, 'source_snapshot_owner_mismatch'); END;
CREATE TRIGGER source_refresh_input_immutable BEFORE UPDATE ON source_refresh_jobs
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.source_definition_id IS NOT OLD.source_definition_id
  OR NEW.definition_version IS NOT OLD.definition_version OR NEW.connector_type IS NOT OLD.connector_type
  OR NEW.concurrency_group IS NOT OLD.concurrency_group OR NEW.scheduled_at IS NOT OLD.scheduled_at
BEGIN SELECT RAISE(ABORT, 'source_refresh_input_immutable'); END;
