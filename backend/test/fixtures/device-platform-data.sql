-- Additional anonymized rows for a database that already received the former
-- db-push-only device-platform schema.
INSERT INTO "devices" (
  "id", "label", "friendly_id", "device_type", "transport", "external_id",
  "capabilities", "configuration", "telemetry", "width", "height", "updated_at"
) VALUES (
  2, 'Fixture Browser', 'fixture-browser', 'browser', 'websocket',
  'fixture-browser-001', '{"width":1280,"height":720}', '{}', '{}', 1280, 720,
  '2026-01-02T00:00:00.000Z'
);

INSERT INTO "device_credentials" (
  "id", "device_id", "kind", "token_hash"
) VALUES (
  1, 2, 'device', 'fixture-sha256-hash-not-a-credential'
);
