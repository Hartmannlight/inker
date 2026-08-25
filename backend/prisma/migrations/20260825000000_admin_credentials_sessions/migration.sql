-- WP-12: installation-wide admin credentials and server-side browser sessions.
-- Secrets are stored only as adaptive password hashes or one-way token hashes.
CREATE TABLE "admin_accounts" (
    "admin_id" TEXT NOT NULL PRIMARY KEY,
    "scope_key" TEXT NOT NULL DEFAULT 'instance',
    "display_name" TEXT NOT NULL DEFAULT 'Administrator',
    "credential_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "admin_accounts_scope_key_key" ON "admin_accounts"("scope_key");

CREATE TABLE "admin_credentials" (
    "credential_id" TEXT NOT NULL PRIMARY KEY,
    "admin_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "password_hash" TEXT,
    "passkey_credential_id" TEXT,
    "passkey_public_key" BLOB,
    "passkey_sign_count" BIGINT,
    "passkey_transports" JSONB,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME,
    "revoked_at" DATETIME,
    CONSTRAINT "admin_credentials_admin_id_fkey"
      FOREIGN KEY ("admin_id") REFERENCES "admin_accounts" ("admin_id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "admin_credentials_kind_material_check" CHECK (
      ("kind" = 'password' AND "password_hash" IS NOT NULL
        AND "passkey_credential_id" IS NULL AND "passkey_public_key" IS NULL)
      OR
      ("kind" = 'passkey' AND "password_hash" IS NULL
        AND "passkey_credential_id" IS NOT NULL AND "passkey_public_key" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "admin_credentials_passkey_credential_id_key"
  ON "admin_credentials"("passkey_credential_id");
CREATE INDEX "admin_credentials_admin_id_kind_revoked_at_idx"
  ON "admin_credentials"("admin_id", "kind", "revoked_at");
CREATE UNIQUE INDEX "admin_credentials_one_active_password"
  ON "admin_credentials"("admin_id")
  WHERE "kind" = 'password' AND "revoked_at" IS NULL;

CREATE TABLE "admin_sessions" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "admin_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "issued_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "user_agent" TEXT,
    "ip_address_hash" TEXT,
    CONSTRAINT "admin_sessions_admin_id_fkey"
      FOREIGN KEY ("admin_id") REFERENCES "admin_accounts" ("admin_id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "admin_sessions_token_hash_key" ON "admin_sessions"("token_hash");
CREATE INDEX "admin_sessions_admin_id_revoked_at_expires_at_idx"
  ON "admin_sessions"("admin_id", "revoked_at", "expires_at");
CREATE INDEX "admin_sessions_expires_at_idx" ON "admin_sessions"("expires_at");
