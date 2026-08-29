CREATE TABLE "playlist_draft_publish_commands" (
  "key_hash" TEXT NOT NULL PRIMARY KEY,
  "request_hash" TEXT NOT NULL,
  "result" JSONB,
  CONSTRAINT "playlist_draft_publish_commands_result_json" CHECK ("result" IS NULL OR json_valid("result"))
);

CREATE TRIGGER "playlist_draft_publish_commands_immutable"
BEFORE UPDATE ON "playlist_draft_publish_commands" WHEN OLD."result" IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'playlist draft publish command immutable'); END;
