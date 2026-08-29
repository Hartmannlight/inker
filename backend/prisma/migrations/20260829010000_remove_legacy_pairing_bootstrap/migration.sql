-- UX-04 retires only the unused long-link bootstrap state. DeviceCredential
-- records are intentionally untouched so already-paired displays remain valid.
DROP INDEX IF EXISTS "devices_pairing_token_hash_key";
ALTER TABLE "devices" DROP COLUMN "pairing_token_hash";
ALTER TABLE "devices" DROP COLUMN "pairing_expires_at";
