-- UX-02: Copy only valid legacy Grafana children into worker-owned sources.
-- Existing AES-GCM ciphertext is copied verbatim and never decrypted here.
ALTER TABLE source_definitions ADD COLUMN legacy_plugin_instance_id INTEGER;
CREATE UNIQUE INDEX source_definitions_legacy_plugin_instance_id_key
  ON source_definitions(legacy_plugin_instance_id);

INSERT INTO source_secrets (id, ciphertext, created_at)
SELECT 'legacy-grafana-' || child.id, json_extract(parent.settings_encrypted, '$.api_key'), CURRENT_TIMESTAMP
FROM plugin_instances child
JOIN plugin_instances parent ON parent.id = CAST(json_extract(child.settings, '$.parentInstanceId') AS INTEGER)
JOIN plugins plugin ON plugin.id = child.plugin_id AND plugin.slug = 'grafana_panel'
WHERE json_type(child.settings, '$.dashboard_uid') IS NOT NULL
  AND json_type(child.settings, '$.panel_id') IS NOT NULL
  AND json_type(parent.settings, '$.grafana_url') IS NOT NULL
  AND json_type(parent.settings_encrypted, '$.api_key') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM source_definitions existing WHERE existing.legacy_plugin_instance_id = child.id);

INSERT INTO source_definitions (source_definition_id, legacy_plugin_instance_id, definition_version, name,
  connector_type, schema_version, configuration, refresh_interval_seconds, timeout_ms,
  concurrency_group, enabled, next_refresh_at, snapshot_revision, consecutive_failures,
  created_at, updated_at, secret_id)
SELECT lower(hex(randomblob(16))), child.id, 1, COALESCE(child.name, 'Migrated Grafana panel ' || child.id),
  'grafana', '1', json_object('baseUrl', json_extract(parent.settings, '$.grafana_url'),
  'operation', 'render', 'dashboardUid', json_extract(child.settings, '$.dashboard_uid'),
  'panelId', CAST(json_extract(child.settings, '$.panel_id') AS INTEGER),
  'width', COALESCE(CAST(json_extract(child.settings, '$.screen_width') AS INTEGER), 800),
  'height', COALESCE(CAST(json_extract(child.settings, '$.screen_height') AS INTEGER), 480),
  'allowLocalNetwork', 0), 300, 7500, 'grafana', 1, CURRENT_TIMESTAMP, 0, 0,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'legacy-grafana-' || child.id
FROM plugin_instances child
JOIN plugin_instances parent ON parent.id = CAST(json_extract(child.settings, '$.parentInstanceId') AS INTEGER)
JOIN plugins plugin ON plugin.id = child.plugin_id AND plugin.slug = 'grafana_panel'
WHERE json_type(child.settings, '$.dashboard_uid') IS NOT NULL
  AND json_type(child.settings, '$.panel_id') IS NOT NULL
  AND json_type(parent.settings, '$.grafana_url') IS NOT NULL
  AND json_type(parent.settings_encrypted, '$.api_key') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM source_definitions existing WHERE existing.legacy_plugin_instance_id = child.id);
