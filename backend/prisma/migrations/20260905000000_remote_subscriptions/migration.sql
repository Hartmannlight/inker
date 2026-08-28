CREATE TABLE "remote_servers" (
  "remote_server_id" TEXT NOT NULL PRIMARY KEY,
  "base_url" TEXT NOT NULL,
  "server_id" TEXT NOT NULL,
  "trusted" BOOLEAN NOT NULL DEFAULT false,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "remote_servers_base_url_key" ON "remote_servers"("base_url");
CREATE UNIQUE INDEX "remote_servers_server_id_key" ON "remote_servers"("server_id");
CREATE TRIGGER "remote_server_identity_immutable" BEFORE UPDATE ON "remote_servers"
WHEN NEW."remote_server_id" != OLD."remote_server_id" OR NEW."base_url" != OLD."base_url" OR NEW."server_id" != OLD."server_id"
BEGIN SELECT RAISE(ABORT, 'Remote origin and identity are immutable'); END;

CREATE TABLE "remote_credentials" (
  "credential_id" TEXT NOT NULL PRIMARY KEY,
  "ciphertext" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "remote_subscriptions" (
  "subscription_id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL CHECK (length("name") BETWEEN 1 AND 100),
  "remote_server_id" TEXT NOT NULL,
  "remote_publication_id" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (typeof("version") = 'integer' AND "version" BETWEEN 1 AND 2147483647),
  "refresh_interval_seconds" INTEGER NOT NULL DEFAULT 60 CHECK (typeof("refresh_interval_seconds") = 'integer' AND "refresh_interval_seconds" BETWEEN 60 AND 86400),
  "next_sync_at" DATETIME NOT NULL,
  "last_attempt_at" DATETIME,
  "last_success_at" DATETIME,
  "last_error_code" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0 CHECK (typeof("consecutive_failures") = 'integer' AND "consecutive_failures" >= 0),
  "circuit_open_until" DATETIME,
  "etag" TEXT CHECK ("etag" IS NULL OR length("etag") <= 200),
  "remote_revision" INTEGER CHECK ("remote_revision" IS NULL OR (typeof("remote_revision") = 'integer' AND "remote_revision" BETWEEN 1 AND 2147483647)),
  "remote_revision_id" TEXT,
  "feed_hash" TEXT CHECK ("feed_hash" IS NULL OR (length("feed_hash") = 64 AND "feed_hash" NOT GLOB '*[^0-9a-f]*')),
  "local_publication_id" TEXT NOT NULL,
  "latest_local_revision_id" TEXT,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  FOREIGN KEY ("remote_server_id") REFERENCES "remote_servers"("remote_server_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("credential_id") REFERENCES "remote_credentials"("credential_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("local_publication_id") REFERENCES "publications"("publication_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  FOREIGN KEY ("latest_local_revision_id") REFERENCES "publication_revisions"("publication_revision_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "remote_subscriptions_credential_id_key" ON "remote_subscriptions"("credential_id");
CREATE UNIQUE INDEX "remote_subscriptions_local_publication_id_key" ON "remote_subscriptions"("local_publication_id");
CREATE UNIQUE INDEX "remote_subscriptions_remote_server_id_remote_publication_id_key" ON "remote_subscriptions"("remote_server_id", "remote_publication_id");
CREATE INDEX "remote_subscriptions_enabled_next_sync_at_idx" ON "remote_subscriptions"("enabled", "next_sync_at");
CREATE INDEX "remote_subscriptions_latest_local_revision_id_idx" ON "remote_subscriptions"("latest_local_revision_id");
CREATE TRIGGER "remote_subscription_scope_immutable" BEFORE UPDATE ON "remote_subscriptions"
WHEN NEW."subscription_id" != OLD."subscription_id" OR NEW."remote_server_id" != OLD."remote_server_id"
  OR NEW."remote_publication_id" != OLD."remote_publication_id" OR NEW."local_publication_id" != OLD."local_publication_id"
BEGIN SELECT RAISE(ABORT, 'Remote subscription scope is immutable'); END;

CREATE TABLE "remote_sync_jobs" (
  "event_id" TEXT NOT NULL PRIMARY KEY,
  "subscription_id" TEXT NOT NULL,
  "subscription_version" INTEGER NOT NULL,
  "remote_server_id" TEXT NOT NULL,
  "scheduled_at" DATETIME NOT NULL,
  "completed_at" DATETIME,
  FOREIGN KEY ("event_id") REFERENCES "outbox_events"("event_id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("subscription_id") REFERENCES "remote_subscriptions"("subscription_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "remote_sync_jobs_subscription_id_completed_at_idx" ON "remote_sync_jobs"("subscription_id", "completed_at");
CREATE INDEX "remote_sync_jobs_remote_server_id_completed_at_idx" ON "remote_sync_jobs"("remote_server_id", "completed_at");
