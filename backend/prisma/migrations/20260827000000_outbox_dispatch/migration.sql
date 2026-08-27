ALTER TABLE "outbox_events" ADD COLUMN "aggregate_revision" TEXT;
ALTER TABLE "outbox_events" ADD COLUMN "claim_token" TEXT;
ALTER TABLE "outbox_events" ADD COLUMN "claim_owner" TEXT;
ALTER TABLE "outbox_events" ADD COLUMN "claim_until" DATETIME;
CREATE INDEX "outbox_events_status_claim_until_idx" ON "outbox_events"("status", "claim_until");
CREATE TABLE "outbox_aggregates" (
  "aggregate_type" TEXT NOT NULL, "aggregate_id" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("aggregate_type", "aggregate_id")
);
CREATE TABLE "outbox_effects" (
  "key" TEXT NOT NULL PRIMARY KEY, "event_id" TEXT NOT NULL, "completed_at" DATETIME
);
CREATE UNIQUE INDEX "outbox_effects_event_id_key" ON "outbox_effects"("event_id");
CREATE TABLE "outbox_deliveries" (
  "delivery_id" TEXT NOT NULL PRIMARY KEY, "effect_key" TEXT NOT NULL, "device_id" INTEGER NOT NULL,
  "presentation" JSONB,
  CONSTRAINT "outbox_deliveries_effect_key_fkey" FOREIGN KEY ("effect_key") REFERENCES "outbox_effects"("key") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "outbox_deliveries_effect_key_device_id_key" ON "outbox_deliveries"("effect_key", "device_id");
CREATE TABLE "outbox_consumers" ("consumer_id" TEXT NOT NULL PRIMARY KEY, "expires_at" DATETIME NOT NULL);
CREATE TABLE "outbox_targets" (
  "effect_key" TEXT NOT NULL, "consumer_id" TEXT NOT NULL, "delivered" BOOLEAN NOT NULL DEFAULT false,
  "attempt_token" TEXT, "last_error" TEXT,
  PRIMARY KEY ("effect_key", "consumer_id"),
  CONSTRAINT "outbox_targets_effect_key_fkey" FOREIGN KEY ("effect_key") REFERENCES "outbox_effects"("key") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "outbox_targets_consumer_id_delivered_idx" ON "outbox_targets"("consumer_id", "delivered");
