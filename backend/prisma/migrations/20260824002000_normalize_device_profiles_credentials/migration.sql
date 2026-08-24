-- WP-06 introduces versioned profile/policy contracts and makes per-device
-- capabilities an explicit override. The legacy device columns stay intact for
-- the existing TRMNL/Web Display paths, but are no longer authoritative.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "device_profiles" (
    "profile_id" TEXT NOT NULL PRIMARY KEY,
    "protocol_version" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "default_capabilities" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "device_profiles_definition_json" CHECK (json_valid("definition")),
    CONSTRAINT "device_profiles_capabilities_json" CHECK (json_valid("default_capabilities"))
);

CREATE TABLE "delivery_policies" (
    "policy_id" TEXT NOT NULL PRIMARY KEY,
    "protocol_version" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "delivery_policies_mode" CHECK ("mode" IN ('sleepy', 'responsive-pull', 'connected')),
    CONSTRAINT "delivery_policies_definition_json" CHECK (json_valid("definition"))
);

INSERT INTO "device_profiles" ("profile_id", "protocol_version", "label", "definition", "default_capabilities", "updated_at") VALUES
('trmnl-byod-7.5-mono', '1.0', 'TRMNL BYOD 7.5 monochrome',
 '{"protocolVersion":"1.0","profileId":"trmnl-byod-7.5-mono","label":"TRMNL BYOD 7.5 monochrome","display":{"width":800,"height":480,"colorSpace":"monochrome","bitDepth":1,"rotation":0,"safeArea":{"top":0,"right":0,"bottom":0,"left":0},"scaling":"contain","renderFormats":["bmp1"],"mimeTypes":["image/bmp"],"eInk":{"partialRefreshSupported":false}},"interaction":{"inputs":["buttons"],"audioOutput":false},"supportedTransports":["http-pull"],"supportedEnergySources":["battery","mains"]}',
 '{"protocolVersion":"1.0","profileId":"trmnl-byod-7.5-mono","display":{"width":800,"height":480,"colorSpace":"monochrome","bitDepth":1,"rotation":0,"safeArea":{"top":0,"right":0,"bottom":0,"left":0},"scaling":"contain","renderFormats":["bmp1"],"mimeTypes":["image/bmp"],"eInk":{"partialRefreshSupported":false}},"transport":{"modes":["http-pull"],"conditionalGet":true,"pushManifests":false,"reconnect":false,"heartbeat":false},"energy":{"source":"battery","canSleep":true,"telemetry":"minimal"},"interaction":{"inputs":["buttons"],"audioOutput":false}}', CURRENT_TIMESTAMP),
('esp32-touch-reference-480x480', '1.0', 'ESP32 touch reference fixture (hardware mapping unverified)',
 '{"protocolVersion":"1.0","profileId":"esp32-touch-reference-480x480","label":"ESP32 touch reference fixture (hardware mapping unverified)","display":{"width":480,"height":480,"colorSpace":"rgb","bitDepth":16,"rotation":0,"safeArea":{"top":0,"right":0,"bottom":0,"left":0},"scaling":"contain","renderFormats":["png","jpeg"],"mimeTypes":["image/png","image/jpeg"]},"interaction":{"inputs":["touch"],"audioOutput":false,"maxTouchPoints":1},"supportedTransports":["websocket","http-pull"],"supportedEnergySources":["mains"]}',
 '{"protocolVersion":"1.0","profileId":"esp32-touch-reference-480x480","display":{"width":480,"height":480,"colorSpace":"rgb","bitDepth":16,"rotation":0,"safeArea":{"top":0,"right":0,"bottom":0,"left":0},"scaling":"contain","renderFormats":["png","jpeg"],"mimeTypes":["image/png","image/jpeg"]},"transport":{"modes":["websocket","http-pull"],"conditionalGet":true,"pushManifests":true,"reconnect":true,"heartbeat":true},"energy":{"source":"mains","canSleep":false,"telemetry":"standard"},"interaction":{"inputs":["touch"],"audioOutput":false,"maxTouchPoints":1}}', CURRENT_TIMESTAMP),
('browser-hd-1920x1080', '1.0', 'Browser kiosk HD',
 '{"protocolVersion":"1.0","profileId":"browser-hd-1920x1080","label":"Browser kiosk HD","display":{"width":1920,"height":1080,"colorSpace":"rgb","bitDepth":24,"rotation":0,"safeArea":{"top":0,"right":0,"bottom":0,"left":0},"scaling":"contain","renderFormats":["html","png","jpeg"],"mimeTypes":["text/html","image/png","image/jpeg"]},"interaction":{"inputs":["pointer"],"audioOutput":true},"supportedTransports":["websocket","http-pull"],"supportedEnergySources":["mains"]}',
 '{"protocolVersion":"1.0","profileId":"browser-hd-1920x1080","display":{"width":1920,"height":1080,"colorSpace":"rgb","bitDepth":24,"rotation":0,"safeArea":{"top":0,"right":0,"bottom":0,"left":0},"scaling":"contain","renderFormats":["html","png","jpeg"],"mimeTypes":["text/html","image/png","image/jpeg"]},"transport":{"modes":["websocket","http-pull"],"conditionalGet":true,"pushManifests":true,"reconnect":true,"heartbeat":true},"energy":{"source":"mains","canSleep":false,"telemetry":"standard"},"interaction":{"inputs":["pointer"],"audioOutput":true}}', CURRENT_TIMESTAMP);

INSERT INTO "delivery_policies" ("policy_id", "protocol_version", "mode", "definition", "updated_at") VALUES
('reference-sleepy', '1.0', 'sleepy', '{"protocolVersion":"1.0","policyId":"reference-sleepy","mode":"sleepy","pollIntervalSeconds":900,"telemetryIntervalSeconds":3600,"maxStaleSeconds":86400}', CURRENT_TIMESTAMP),
('reference-responsive-pull', '1.0', 'responsive-pull', '{"protocolVersion":"1.0","policyId":"reference-responsive-pull","mode":"responsive-pull","pollIntervalSeconds":60,"telemetryIntervalSeconds":300,"maxStaleSeconds":3600}', CURRENT_TIMESTAMP),
('reference-connected-embedded', '1.0', 'connected', '{"protocolVersion":"1.0","policyId":"reference-connected-embedded","mode":"connected","heartbeatSeconds":30,"reconnectBackoffSeconds":5,"telemetryIntervalSeconds":60,"maxStaleSeconds":3600}', CURRENT_TIMESTAMP),
('reference-connected-browser', '1.0', 'connected', '{"protocolVersion":"1.0","policyId":"reference-connected-browser","mode":"connected","heartbeatSeconds":20,"reconnectBackoffSeconds":2,"telemetryIntervalSeconds":60,"maxStaleSeconds":3600}', CURRENT_TIMESTAMP);

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
    "profile_id" TEXT NOT NULL,
    "capabilities_override" JSONB,
    "delivery_policy_id" TEXT NOT NULL,
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
    CONSTRAINT "devices_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "devices_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "device_profiles" ("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "devices_delivery_policy_id_fkey" FOREIGN KEY ("delivery_policy_id") REFERENCES "delivery_policies" ("policy_id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "devices_capabilities_override_json" CHECK ("capabilities_override" IS NULL OR json_valid("capabilities_override")),
    CONSTRAINT "devices_capabilities_override_identity" CHECK ("capabilities_override" IS NULL OR (json_type("capabilities_override", '$.profileId') IS NULL AND json_type("capabilities_override", '$.protocolVersion') IS NULL))
);

INSERT INTO "new_devices" (
    "id", "label", "friendly_id", "device_type", "transport", "external_id", "capabilities", "configuration", "telemetry", "profile_id", "capabilities_override", "delivery_policy_id", "mac_address", "api_key", "pairing_token_hash", "pairing_expires_at", "last_connected_at", "presentation_revision", "firmware_version", "model_id", "playlist_id", "is_active", "wifi", "battery", "refresh_rate", "image_timeout", "width", "height", "proxy", "firmware_update", "sleep_start_at", "sleep_stop_at", "show_sleep_screen", "last_seen_at", "refresh_pending", "last_screen_id", "screen_started_at", "created_at", "updated_at"
)
SELECT
    "id", "label", "friendly_id", "device_type", "transport", "external_id", "capabilities", "configuration", "telemetry",
    CASE WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN 'browser-hd-1920x1080' ELSE 'trmnl-byod-7.5-mono' END,
    json_object('display', json_object(
      'width', CASE WHEN "width" > 0 THEN "width" WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN 1920 ELSE 800 END,
      'height', CASE WHEN "height" > 0 THEN "height" WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN 1080 ELSE 480 END,
      'colorSpace', CASE
        WHEN "model_id" IS NOT NULL AND COALESCE((SELECT "colors" FROM "models" WHERE "id" = "devices"."model_id"), 2) > 2 THEN 'grayscale'
        WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN 'rgb'
        ELSE 'monochrome'
      END,
      'bitDepth', COALESCE(
        (SELECT "bit_depth" FROM "models" WHERE "id" = "devices"."model_id"),
        CASE WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN 24 ELSE 1 END
      ),
      'renderFormats', json(CASE
        WHEN (SELECT "mime_type" FROM "models" WHERE "id" = "devices"."model_id") = 'image/bmp' THEN '["bmp1"]'
        WHEN (SELECT "mime_type" FROM "models" WHERE "id" = "devices"."model_id") = 'image/jpeg' THEN '["jpeg"]'
        WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN '["html","png","jpeg"]'
        ELSE '["png"]'
      END),
      'mimeTypes', json(CASE
        WHEN (SELECT "mime_type" FROM "models" WHERE "id" = "devices"."model_id") = 'image/bmp' THEN '["image/bmp"]'
        WHEN (SELECT "mime_type" FROM "models" WHERE "id" = "devices"."model_id") = 'image/jpeg' THEN '["image/jpeg"]'
        WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN '["text/html","image/png","image/jpeg"]'
        ELSE '["image/png"]'
      END)
    )),
    CASE WHEN "device_type" IN ('browser', 'web-display') OR "transport" = 'websocket' THEN 'reference-connected-browser' ELSE 'reference-sleepy' END,
    "mac_address", "api_key", "pairing_token_hash", "pairing_expires_at", "last_connected_at", "presentation_revision", "firmware_version", "model_id", "playlist_id", "is_active", "wifi", "battery", "refresh_rate", "image_timeout", "width", "height", "proxy", "firmware_update", "sleep_start_at", "sleep_stop_at", "show_sleep_screen", "last_seen_at", "refresh_pending", "last_screen_id", "screen_started_at", "created_at", "updated_at"
FROM "devices";

DROP TABLE "devices";
ALTER TABLE "new_devices" RENAME TO "devices";
CREATE UNIQUE INDEX "devices_external_id_key" ON "devices"("external_id");
CREATE UNIQUE INDEX "devices_mac_address_key" ON "devices"("mac_address");
CREATE UNIQUE INDEX "devices_api_key_key" ON "devices"("api_key");
CREATE UNIQUE INDEX "devices_pairing_token_hash_key" ON "devices"("pairing_token_hash");

CREATE TABLE "new_device_credentials" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "credential_id" TEXT NOT NULL,
    "device_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'device',
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME,
    "last_used_at" DATETIME,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_credentials_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_device_credentials" ("id", "credential_id", "device_id", "kind", "token_hash", "last_used_at", "revoked_at", "created_at")
SELECT "id", 'legacy-' || printf('%08d', "id"), "device_id", "kind", "token_hash", "last_used_at", "revoked_at", "created_at"
FROM "device_credentials";

DROP TABLE "device_credentials";
ALTER TABLE "new_device_credentials" RENAME TO "device_credentials";
CREATE UNIQUE INDEX "device_credentials_credential_id_key" ON "device_credentials"("credential_id");
CREATE UNIQUE INDEX "device_credentials_token_hash_key" ON "device_credentials"("token_hash");
CREATE INDEX "device_credentials_device_id_idx" ON "device_credentials"("device_id");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
