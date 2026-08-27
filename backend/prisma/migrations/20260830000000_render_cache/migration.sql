ALTER TABLE "devices" ADD COLUMN "render_revision" INTEGER NOT NULL DEFAULT 0 CHECK ("render_revision" >= 0);
CREATE TABLE "render_requests" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "publication_revision_id" TEXT NOT NULL,
  "target" JSONB NOT NULL,
  "renderer_version" TEXT NOT NULL,
  "artifact_hash" TEXT,
  "mime_type" TEXT,
  "size_bytes" INTEGER,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" DATETIME,
  CONSTRAINT "render_requests_publication_revision_id_fkey" FOREIGN KEY ("publication_revision_id") REFERENCES "publication_revisions" ("publication_revision_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (length("key") = 64),
  CHECK (("artifact_hash" IS NULL AND "mime_type" IS NULL AND "size_bytes" IS NULL AND "completed_at" IS NULL)
    OR ("artifact_hash" IS NOT NULL AND "mime_type" IS NOT NULL AND "size_bytes" IS NOT NULL
      AND length("artifact_hash") = 64 AND "mime_type" IN ('image/png','image/jpeg','image/bmp')
      AND "size_bytes" > 0 AND "size_bytes" <= 16777216 AND "completed_at" IS NOT NULL))
);
CREATE INDEX "render_requests_publication_revision_id_idx" ON "render_requests"("publication_revision_id");
CREATE TABLE "render_bindings" (
  "device_id" INTEGER NOT NULL,
  "variant" TEXT NOT NULL,
  "desired_key" TEXT NOT NULL,
  "ready_key" TEXT,
  "previous_key" TEXT,
  PRIMARY KEY ("device_id", "variant"),
  CONSTRAINT "render_bindings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "render_bindings_desired_key_fkey" FOREIGN KEY ("desired_key") REFERENCES "render_requests" ("key") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "render_bindings_ready_key_fkey" FOREIGN KEY ("ready_key") REFERENCES "render_requests" ("key") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "render_bindings_previous_key_fkey" FOREIGN KEY ("previous_key") REFERENCES "render_requests" ("key") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TRIGGER "render_request_inputs_immutable" BEFORE UPDATE ON "render_requests"
WHEN NEW."key" != OLD."key" OR NEW."publication_revision_id" != OLD."publication_revision_id"
  OR NEW."target" != OLD."target" OR NEW."renderer_version" != OLD."renderer_version"
  OR OLD."completed_at" IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Render inputs and completed artifacts are immutable'); END;
