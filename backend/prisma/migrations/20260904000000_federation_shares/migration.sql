CREATE TABLE "federation_identity" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
  "server_id" TEXT NOT NULL CHECK (length("server_id") = 36),
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "federation_identity_server_id_key" ON "federation_identity"("server_id");
CREATE TRIGGER "federation_identity_immutable" BEFORE UPDATE ON "federation_identity"
BEGIN SELECT RAISE(ABORT, 'Federation identity is immutable'); END;

CREATE TABLE "share_credentials" (
  "credential_id" TEXT NOT NULL PRIMARY KEY,
  "token_hash" TEXT NOT NULL CHECK (length("token_hash") = 64 AND "token_hash" NOT GLOB '*[^0-9a-f]*'),
  "publication_id" TEXT NOT NULL,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" DATETIME,
  "revoked_at" DATETIME,
  "created_by_admin_id" TEXT,
  FOREIGN KEY ("publication_id") REFERENCES "publications"("publication_id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_accounts"("admin_id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "share_credentials_token_hash_key" ON "share_credentials"("token_hash");
CREATE INDEX "share_credentials_publication_id_revoked_at_expires_at_idx" ON "share_credentials"("publication_id", "revoked_at", "expires_at");
CREATE INDEX "share_credentials_created_at_idx" ON "share_credentials"("created_at");
CREATE TRIGGER "share_credential_scope_immutable" BEFORE UPDATE ON "share_credentials"
WHEN NEW."publication_id" != OLD."publication_id" OR NEW."token_hash" != OLD."token_hash"
  OR NEW."credential_id" != OLD."credential_id" OR NEW."created_at" != OLD."created_at"
  OR NEW."expires_at" IS NOT OLD."expires_at"
  OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NOT OLD."revoked_at")
BEGIN SELECT RAISE(ABORT, 'Share scope and revocation are immutable'); END;
