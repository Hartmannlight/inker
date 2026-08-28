-- Existing definitions keep their trusted connector behavior (NULL).
-- Source service updates fence code changes with definition_version.
ALTER TABLE "source_definitions" ADD COLUMN "transformation_code" TEXT
  CHECK ("transformation_code" IS NULL OR length("transformation_code") <= 10000);
