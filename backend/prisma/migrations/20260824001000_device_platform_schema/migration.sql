-- Preserve released device rows while adopting the generic device-platform
-- fields which were previously applied with `prisma db push` in the fork.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_devices" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL,
    "friendly_id" TEXT,
    "device_type" TEXT NOT NULL DEFAULT 'trmnl',
    "transport" TEXT NOT NULL DEFAULT 'pull',
    "external_id" TEXT,
    "capabilities" JSONB,
    "configuration" JSONB,
    "telemetry" JSONB,
    "mac_address" TEXT,
    "api_key" TEXT,
    "pairing_token_hash" TEXT,
    "pairing_expires_at" DATETIME,
    "last_connected_at" DATETIME,
    "presentation_revision" INTEGER NOT NULL DEFAULT 0,
    "firmware_version" TEXT,
    "model_id" INTEGER,
    "playlist_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "wifi" INTEGER NOT NULL DEFAULT 0,
    "battery" REAL NOT NULL DEFAULT 0,
    "refresh_rate" INTEGER NOT NULL DEFAULT 900,
    "image_timeout" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "proxy" BOOLEAN NOT NULL DEFAULT false,
    "firmware_update" BOOLEAN NOT NULL DEFAULT true,
    "sleep_start_at" TEXT,
    "sleep_stop_at" TEXT,
    "show_sleep_screen" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" DATETIME,
    "refresh_pending" BOOLEAN NOT NULL DEFAULT false,
    "last_screen_id" TEXT,
    "screen_started_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "devices_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "devices_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_devices" (
    "id", "label", "friendly_id", "mac_address", "api_key",
    "firmware_version", "model_id", "playlist_id", "is_active", "wifi",
    "battery", "refresh_rate", "image_timeout", "width", "height", "proxy",
    "firmware_update", "sleep_start_at", "sleep_stop_at", "show_sleep_screen",
    "last_seen_at", "refresh_pending", "last_screen_id", "screen_started_at",
    "created_at", "updated_at"
)
SELECT
    "id", "label", "friendly_id", "mac_address", "api_key",
    "firmware_version", "model_id", "playlist_id", "is_active", "wifi",
    "battery", "refresh_rate", "image_timeout", "width", "height", "proxy",
    "firmware_update", "sleep_start_at", "sleep_stop_at", "show_sleep_screen",
    "last_seen_at", "refresh_pending", "last_screen_id", "screen_started_at",
    "created_at", "updated_at"
FROM "devices";

DROP TABLE "devices";
ALTER TABLE "new_devices" RENAME TO "devices";

CREATE TABLE "device_credentials" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'device',
    "token_hash" TEXT NOT NULL,
    "last_used_at" DATETIME,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_credentials_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "devices_external_id_key" ON "devices"("external_id");
CREATE UNIQUE INDEX "devices_mac_address_key" ON "devices"("mac_address");
CREATE UNIQUE INDEX "devices_api_key_key" ON "devices"("api_key");
CREATE UNIQUE INDEX "devices_pairing_token_hash_key" ON "devices"("pairing_token_hash");
CREATE UNIQUE INDEX "device_credentials_token_hash_key" ON "device_credentials"("token_hash");
CREATE INDEX "device_credentials_device_id_idx" ON "device_credentials"("device_id");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
