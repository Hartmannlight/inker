CREATE TABLE "interaction_receipts" (
  "device_id" INTEGER NOT NULL, "event_id" TEXT NOT NULL, "command_id" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL, "publication_id" TEXT NOT NULL, "publication_revision" TEXT NOT NULL,
  "action" TEXT NOT NULL, "target_id" TEXT, "request_hash" TEXT NOT NULL, "result" JSONB NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("device_id", "event_id"),
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "interaction_receipts_command_id_key" ON "interaction_receipts"("command_id");
CREATE INDEX "interaction_receipts_created_at_idx" ON "interaction_receipts"("created_at");
CREATE TABLE "interaction_rates" (
  "device_id" INTEGER NOT NULL PRIMARY KEY, "minute_at" DATETIME NOT NULL, "minute_count" INTEGER NOT NULL,
  "second_at" DATETIME NOT NULL, "second_count" INTEGER NOT NULL,
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "interaction_sequences" (
  "credential_id" TEXT NOT NULL PRIMARY KEY, "last_sequence" INTEGER NOT NULL, "updated_at" DATETIME NOT NULL,
  FOREIGN KEY ("credential_id") REFERENCES "device_credentials"("credential_id") ON DELETE CASCADE ON UPDATE CASCADE
);
