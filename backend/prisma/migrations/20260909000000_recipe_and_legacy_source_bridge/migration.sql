-- Preserve the TRMNL device protocol while moving mutable legacy content onto
-- worker-owned source snapshots and immutable recipe revisions.
ALTER TABLE source_definitions ADD COLUMN legacy_data_source_id INTEGER;
CREATE UNIQUE INDEX source_definitions_legacy_data_source_id_key
  ON source_definitions(legacy_data_source_id);

CREATE TABLE recipe_definitions (
  recipe_definition_id TEXT NOT NULL PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'inker',
  source_url TEXT,
  license TEXT,
  legacy_plugin_id INTEGER,
  active_revision_id TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL,
  CONSTRAINT recipe_definitions_legacy_plugin_id_fkey
    FOREIGN KEY (legacy_plugin_id) REFERENCES plugins(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT recipe_definitions_active_revision_id_fkey
    FOREIGN KEY (active_revision_id) REFERENCES recipe_revisions(recipe_revision_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX recipe_definitions_slug_key ON recipe_definitions(slug);
CREATE UNIQUE INDEX recipe_definitions_legacy_plugin_id_key ON recipe_definitions(legacy_plugin_id);
CREATE UNIQUE INDEX recipe_definitions_active_revision_id_key ON recipe_definitions(active_revision_id);

CREATE TABLE recipe_revisions (
  recipe_revision_id TEXT NOT NULL PRIMARY KEY,
  recipe_definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  manifest_version INTEGER NOT NULL DEFAULT 1 CHECK (manifest_version = 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  manifest JSONB NOT NULL,
  layouts JSONB NOT NULL,
  partials JSONB NOT NULL,
  settings_schema JSONB NOT NULL,
  required_connector_type TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT recipe_revisions_recipe_definition_id_fkey
    FOREIGN KEY (recipe_definition_id) REFERENCES recipe_definitions(recipe_definition_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX recipe_revisions_recipe_definition_id_revision_key
  ON recipe_revisions(recipe_definition_id, revision);
CREATE INDEX recipe_revisions_recipe_definition_id_content_hash_idx
  ON recipe_revisions(recipe_definition_id, content_hash);

CREATE TABLE recipe_bindings (
  recipe_binding_id TEXT NOT NULL PRIMARY KEY,
  recipe_definition_id TEXT NOT NULL,
  recipe_revision_id TEXT NOT NULL,
  source_definition_id TEXT,
  legacy_plugin_instance_id INTEGER,
  name TEXT,
  settings JSONB NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL,
  CONSTRAINT recipe_bindings_recipe_definition_id_fkey
    FOREIGN KEY (recipe_definition_id) REFERENCES recipe_definitions(recipe_definition_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT recipe_bindings_recipe_revision_id_fkey
    FOREIGN KEY (recipe_revision_id) REFERENCES recipe_revisions(recipe_revision_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT recipe_bindings_source_definition_id_fkey
    FOREIGN KEY (source_definition_id) REFERENCES source_definitions(source_definition_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT recipe_bindings_legacy_plugin_instance_id_fkey
    FOREIGN KEY (legacy_plugin_instance_id) REFERENCES plugin_instances(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX recipe_bindings_legacy_plugin_instance_id_key
  ON recipe_bindings(legacy_plugin_instance_id);
CREATE INDEX recipe_bindings_recipe_definition_id_idx ON recipe_bindings(recipe_definition_id);
CREATE INDEX recipe_bindings_source_definition_id_idx ON recipe_bindings(source_definition_id);

PRAGMA defer_foreign_keys=ON;
CREATE TABLE new_playlist_items (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  screen_id INTEGER,
  screen_design_id INTEGER,
  "order" INTEGER NOT NULL DEFAULT 0,
  duration INTEGER DEFAULT 60,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  plugin_instance_id INTEGER,
  recipe_binding_id TEXT,
  CONSTRAINT playlist_items_playlist_id_fkey FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT playlist_items_screen_id_fkey FOREIGN KEY (screen_id) REFERENCES screens(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT playlist_items_screen_design_id_fkey FOREIGN KEY (screen_design_id) REFERENCES screen_designs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT playlist_items_plugin_instance_id_fkey FOREIGN KEY (plugin_instance_id) REFERENCES plugin_instances(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT playlist_items_recipe_binding_id_fkey FOREIGN KEY (recipe_binding_id) REFERENCES recipe_bindings(recipe_binding_id) ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO new_playlist_items
  (id, playlist_id, screen_id, screen_design_id, "order", duration, created_at, plugin_instance_id)
SELECT id, playlist_id, screen_id, screen_design_id, "order", duration, created_at, plugin_instance_id
FROM playlist_items;
DROP TABLE playlist_items;
ALTER TABLE new_playlist_items RENAME TO playlist_items;
CREATE INDEX playlist_items_recipe_binding_id_idx ON playlist_items(recipe_binding_id);

-- Rebuild custom_widgets so new widgets may point only at SourceDefinition.
CREATE TABLE new_custom_widgets (
  id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  data_source_id INTEGER,
  source_definition_id TEXT,
  "displayType" TEXT NOT NULL,
  template TEXT,
  config JSONB NOT NULL,
  min_width INTEGER NOT NULL DEFAULT 100,
  min_height INTEGER NOT NULL DEFAULT 50,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL,
  CONSTRAINT custom_widgets_data_source_id_fkey
    FOREIGN KEY (data_source_id) REFERENCES data_sources(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT custom_widgets_source_definition_id_fkey
    FOREIGN KEY (source_definition_id) REFERENCES source_definitions(source_definition_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (data_source_id IS NOT NULL OR source_definition_id IS NOT NULL)
);
INSERT INTO new_custom_widgets
  (id, name, description, data_source_id, "displayType", template, config,
   min_width, min_height, created_at, updated_at)
SELECT id, name, description, data_source_id, "displayType", template, config,
       min_width, min_height, created_at, updated_at
FROM custom_widgets;
DROP TABLE custom_widgets;
ALTER TABLE new_custom_widgets RENAME TO custom_widgets;
PRAGMA defer_foreign_keys=OFF;

-- Immutable recipe revisions must never be rewritten or deleted after use.
CREATE TRIGGER recipe_revision_immutable_update BEFORE UPDATE ON recipe_revisions
BEGIN SELECT RAISE(ABORT, 'recipe_revision_immutable'); END;
CREATE TRIGGER recipe_revision_immutable_delete BEFORE DELETE ON recipe_revisions
BEGIN SELECT RAISE(ABORT, 'recipe_revision_immutable'); END;
