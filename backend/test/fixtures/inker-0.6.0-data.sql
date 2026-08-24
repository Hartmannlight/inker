-- Anonymized representative data for the released Inker 0.6.0 schema.
-- The migration test combines this data with the 0.6.0 baseline migration to
-- create a portable test image without committing a binary SQLite database.
INSERT INTO "models" (
  "id", "name", "label", "width", "height", "updated_at"
) VALUES (
  1, 'fixture-model', 'Fixture Model', 800, 480, '2026-01-01T00:00:00.000Z'
);

INSERT INTO "playlists" (
  "id", "name", "description", "updated_at"
) VALUES (
  1, 'Fixture Playlist', 'Synthetic migration data', '2026-01-01T00:00:00.000Z'
);

INSERT INTO "devices" (
  "id", "label", "friendly_id", "mac_address", "api_key", "model_id",
  "playlist_id", "width", "height", "updated_at"
) VALUES (
  1, 'Fixture Device', 'fixture-device', '02:00:00:00:00:01',
  'fixture-api-key-not-a-secret', 1, 1, 800, 480,
  '2026-01-01T00:00:00.000Z'
);

INSERT INTO "settings" (
  "id", "key", "value", "updated_at"
) VALUES (
  1, 'fixture.setting', 'synthetic-value', '2026-01-01T00:00:00.000Z'
);
