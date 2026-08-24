-- Inker 0.6.0 schema baseline. Existing 0.6.0 databases are verified against
-- this schema before the migration is marked as applied.

CREATE TABLE "devices" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL,
    "friendly_id" TEXT,
    "mac_address" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
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

CREATE TABLE "models" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "description" TEXT,
    "mime_type" TEXT NOT NULL DEFAULT 'image/png',
    "colors" INTEGER NOT NULL DEFAULT 2,
    "bit_depth" INTEGER NOT NULL DEFAULT 1,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "offset_x" INTEGER NOT NULL DEFAULT 0,
    "offset_y" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'terminus',
    "scale_factor" REAL NOT NULL DEFAULT 1.0,
    "published_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "screens" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "model_id" INTEGER,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "screens_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "playlists" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "advance_on_tap" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "playlist_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "playlist_id" INTEGER NOT NULL,
    "screen_id" INTEGER,
    "screen_design_id" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER DEFAULT 60,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plugin_instance_id" INTEGER,
    CONSTRAINT "playlist_items_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "playlist_items_screen_id_fkey" FOREIGN KEY ("screen_id") REFERENCES "screens" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "playlist_items_screen_design_id_fkey" FOREIGN KEY ("screen_design_id") REFERENCES "screen_designs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "playlist_items_plugin_instance_id_fkey" FOREIGN KEY ("plugin_instance_id") REFERENCES "plugin_instances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "extensions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "data_sources" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "headers" JSONB,
    "refresh_interval" INTEGER NOT NULL DEFAULT 300,
    "json_path" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_fetched_at" DATETIME,
    "last_data" JSONB,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "custom_widgets" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "data_source_id" INTEGER NOT NULL,
    "displayType" TEXT NOT NULL,
    "template" TEXT,
    "config" JSONB NOT NULL,
    "min_width" INTEGER NOT NULL DEFAULT 100,
    "min_height" INTEGER NOT NULL DEFAULT 50,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "custom_widgets_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "data_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "firmware" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "version" TEXT NOT NULL,
    "download_url" TEXT NOT NULL,
    "release_notes" TEXT,
    "is_stable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "device_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device_id" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_logs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "widget_templates" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "defaultConfig" JSONB NOT NULL,
    "min_width" INTEGER NOT NULL DEFAULT 100,
    "min_height" INTEGER NOT NULL DEFAULT 50,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "screen_designs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "width" INTEGER NOT NULL DEFAULT 800,
    "height" INTEGER NOT NULL DEFAULT 480,
    "background" TEXT NOT NULL DEFAULT '#FFFFFF',
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "screen_widgets" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "screen_design_id" INTEGER NOT NULL,
    "template_id" INTEGER NOT NULL,
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER NOT NULL DEFAULT 200,
    "height" INTEGER NOT NULL DEFAULT 100,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "z_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "screen_widgets_screen_design_id_fkey" FOREIGN KEY ("screen_design_id") REFERENCES "screen_designs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "screen_widgets_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "widget_templates" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "device_screen_assignments" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "device_id" INTEGER NOT NULL,
    "screen_design_id" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_screen_assignments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_screen_assignments_screen_design_id_fkey" FOREIGN KEY ("screen_design_id") REFERENCES "screen_designs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "blocked_devices" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "mac_address" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "plugins" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "category" TEXT NOT NULL DEFAULT 'custom',
    "data_strategy" TEXT NOT NULL DEFAULT 'polling',
    "data_url" TEXT,
    "data_method" TEXT NOT NULL DEFAULT 'GET',
    "data_headers" JSONB,
    "data_path" TEXT,
    "data_transform" TEXT,
    "refresh_interval" INTEGER NOT NULL DEFAULT 300,
    "markup_full" TEXT,
    "markup_half_horizontal" TEXT,
    "markup_half_vertical" TEXT,
    "markup_quadrant" TEXT,
    "settings_schema" JSONB,
    "oauth_provider" TEXT,
    "oauth_scopes" TEXT,
    "is_installed" BOOLEAN NOT NULL DEFAULT false,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'inker',
    "source_url" TEXT,
    "source_hash" TEXT,
    "version" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE TABLE "plugin_instances" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plugin_id" INTEGER NOT NULL,
    "name" TEXT,
    "settings" JSONB NOT NULL,
    "settings_encrypted" JSONB NOT NULL,
    "oauth_token" TEXT,
    "oauth_refresh_token" TEXT,
    "oauth_expires_at" DATETIME,
    "last_data" JSONB,
    "last_fetched_at" DATETIME,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "plugin_instances_plugin_id_fkey" FOREIGN KEY ("plugin_id") REFERENCES "plugins" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "devices_mac_address_key" ON "devices"("mac_address");
CREATE UNIQUE INDEX "devices_api_key_key" ON "devices"("api_key");
CREATE UNIQUE INDEX "models_name_key" ON "models"("name");
CREATE UNIQUE INDEX "firmware_version_key" ON "firmware"("version");
CREATE UNIQUE INDEX "widget_templates_name_key" ON "widget_templates"("name");
CREATE UNIQUE INDEX "device_screen_assignments_device_id_screen_design_id_key" ON "device_screen_assignments"("device_id", "screen_design_id");
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");
CREATE UNIQUE INDEX "blocked_devices_mac_address_key" ON "blocked_devices"("mac_address");
CREATE UNIQUE INDEX "plugins_slug_key" ON "plugins"("slug");
