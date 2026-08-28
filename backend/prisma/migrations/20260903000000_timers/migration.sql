CREATE TABLE "timers" (
  "timer_id" TEXT NOT NULL PRIMARY KEY,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (typeof("version") = 'integer' AND "version" BETWEEN 1 AND 2147483647),
  "creator_device_id" INTEGER,
  "creator_external_id" TEXT NOT NULL,
  "visibility" TEXT NOT NULL CHECK ("visibility" IN ('private', 'shared')),
  "status" TEXT NOT NULL CHECK ("status" IN ('running', 'paused', 'completed', 'cancelled')),
  "duration_ms" INTEGER NOT NULL CHECK (typeof("duration_ms") = 'integer' AND "duration_ms" BETWEEN 1000 AND 604800000),
  "started_at" DATETIME NOT NULL CHECK (typeof("started_at") = 'integer' AND "started_at" BETWEEN 0 AND 253402300799999),
  "ends_at" DATETIME CHECK ("ends_at" IS NULL OR (typeof("ends_at") = 'integer' AND "ends_at" BETWEEN 0 AND 253402300799999)),
  "paused_remaining_ms" INTEGER CHECK ("paused_remaining_ms" IS NULL OR typeof("paused_remaining_ms") = 'integer'),
  "evaluated_at" DATETIME NOT NULL CHECK (typeof("evaluated_at") = 'integer' AND "evaluated_at" BETWEEN 0 AND 253402300799999),
  "completed_at" DATETIME CHECK ("completed_at" IS NULL OR (typeof("completed_at") = 'integer' AND "completed_at" BETWEEN 0 AND 253402300799999)),
  "cancelled_at" DATETIME CHECK ("cancelled_at" IS NULL OR (typeof("cancelled_at") = 'integer' AND "cancelled_at" BETWEEN 0 AND 253402300799999)),
  "acknowledged_at" DATETIME CHECK ("acknowledged_at" IS NULL OR (typeof("acknowledged_at") = 'integer' AND "acknowledged_at" BETWEEN 0 AND 253402300799999)),
  "acknowledged_by_device_id" INTEGER,
  "acknowledged_by_external_id" TEXT,
  FOREIGN KEY ("creator_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  FOREIGN KEY ("acknowledged_by_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CHECK ("started_at" <= "evaluated_at"),
  CHECK (("acknowledged_at" IS NULL AND "acknowledged_by_external_id" IS NULL AND "acknowledged_by_device_id" IS NULL)
    OR ("status" = 'completed' AND "acknowledged_at" IS NOT NULL AND "acknowledged_by_external_id" IS NOT NULL
      AND "acknowledged_at" >= "completed_at" AND "acknowledged_at" <= "evaluated_at")),
  CHECK (
    ("status" = 'running' AND "ends_at" IS NOT NULL AND "ends_at" > "evaluated_at" AND "ends_at" - "evaluated_at" <= "duration_ms"
      AND "paused_remaining_ms" IS NULL AND "completed_at" IS NULL AND "cancelled_at" IS NULL AND "acknowledged_at" IS NULL)
    OR ("status" = 'paused' AND "ends_at" IS NULL AND "paused_remaining_ms" IS NOT NULL AND "paused_remaining_ms" > 0 AND "paused_remaining_ms" <= "duration_ms"
      AND "completed_at" IS NULL AND "cancelled_at" IS NULL AND "acknowledged_at" IS NULL)
    OR ("status" = 'completed' AND "ends_at" IS NOT NULL AND "completed_at" IS NOT NULL AND "completed_at" = "ends_at"
      AND "completed_at" > "started_at" AND "completed_at" <= "evaluated_at" AND "paused_remaining_ms" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'cancelled' AND "ends_at" IS NULL AND "paused_remaining_ms" IS NULL AND "cancelled_at" IS NOT NULL
      AND "cancelled_at" >= "started_at" AND "cancelled_at" <= "evaluated_at" AND "completed_at" IS NULL AND "acknowledged_at" IS NULL)
  )
);
CREATE INDEX "timers_status_ends_at_idx" ON "timers"("status", "ends_at");
CREATE INDEX "timers_creator_device_id_status_idx" ON "timers"("creator_device_id", "status");
CREATE INDEX "timers_visibility_status_idx" ON "timers"("visibility", "status");
