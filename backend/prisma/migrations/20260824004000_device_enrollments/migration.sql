-- WP-09 adds durable one-time enrollment state after the existing WP-07
-- publication/outbox migration. Pairing codes and device credentials are stored
-- only as SHA-256 hashes.
CREATE TABLE "device_enrollments" (
    "enrollment_id" TEXT NOT NULL PRIMARY KEY,
    "device_id" INTEGER NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_enrollments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_enrollments_attempt_count" CHECK ("attempt_count" >= 0 AND "attempt_count" <= 5)
);

CREATE UNIQUE INDEX "device_enrollments_code_hash_key" ON "device_enrollments"("code_hash");
CREATE INDEX "device_enrollments_device_id_used_at_idx" ON "device_enrollments"("device_id", "used_at");
CREATE INDEX "device_enrollments_expires_at_idx" ON "device_enrollments"("expires_at");
