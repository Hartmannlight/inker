-- Explicit playlist releases and independent, restart-safe device playback.
-- No draft adoption, pointer/sequence rewrite or modification of old migrations.
CREATE TABLE "published_playlists" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "playlist_id" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "content_hash" TEXT NOT NULL,
  "published_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "published_playlists_playlist_id_revision_key" ON "published_playlists"("playlist_id", "revision");
CREATE TABLE "published_playlist_entries" (
  "playlist_revision_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0 AND "ordinal" < 100),
  "item_id" INTEGER NOT NULL,
  "duration_ms" INTEGER CHECK ("duration_ms" IS NULL OR "duration_ms" BETWEEN 1000 AND 86400000),
  "publication_revision_id" TEXT NOT NULL,
  PRIMARY KEY ("playlist_revision_id", "ordinal"),
  CONSTRAINT "published_playlist_entries_playlist_revision_id_fkey" FOREIGN KEY ("playlist_revision_id") REFERENCES "published_playlists"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "published_playlist_entries_publication_revision_id_fkey" FOREIGN KEY ("publication_revision_id") REFERENCES "publication_revisions"("publication_revision_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "published_playlist_entries_playlist_revision_id_item_id_key" ON "published_playlist_entries"("playlist_revision_id", "item_id");
CREATE INDEX "published_playlist_entries_publication_revision_id_idx" ON "published_playlist_entries"("publication_revision_id");
CREATE TABLE "playback_states" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "device_id" INTEGER NOT NULL,
  "playlist_revision_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('empty','running','paused','stopped')),
  "anchor_index" INTEGER NOT NULL CHECK ("anchor_index" >= 0),
  "anchor_at" DATETIME NOT NULL,
  "elapsed_ms" REAL NOT NULL CHECK ("elapsed_ms" >= 0),
  "evaluated_at" DATETIME NOT NULL,
  "current_item_id" INTEGER,
  "next_transition_at" DATETIME,
  CONSTRAINT "playback_states_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "playback_states_playlist_revision_id_fkey" FOREIGN KEY ("playlist_revision_id") REFERENCES "published_playlists"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "playback_states_device_id_key" ON "playback_states"("device_id");
CREATE INDEX "playback_states_status_next_transition_at_idx" ON "playback_states"("status", "next_transition_at");
CREATE TABLE "playback_commands" (
  "key_hash" TEXT NOT NULL PRIMARY KEY,
  "request_hash" TEXT NOT NULL,
  "result" JSONB
);
CREATE TRIGGER "published_playlists_immutable" BEFORE UPDATE ON "published_playlists"
BEGIN SELECT RAISE(ABORT, 'Published playlists are immutable'); END;
CREATE TRIGGER "published_playlist_entries_immutable" BEFORE UPDATE ON "published_playlist_entries"
BEGIN SELECT RAISE(ABORT, 'Published playlist entries are immutable'); END;
CREATE TRIGGER "playback_commands_immutable" BEFORE UPDATE ON "playback_commands" WHEN OLD."result" IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Completed playback commands are immutable'); END;
