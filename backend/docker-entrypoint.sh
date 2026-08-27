#!/bin/sh
set -e

# Create all required directories
mkdir -p /app/uploads/screens
mkdir -p /app/uploads/firmware
mkdir -p /app/uploads/widgets
mkdir -p /app/uploads/captures
mkdir -p /app/uploads/drawings
mkdir -p /app/logs
mkdir -p /app/secrets
mkdir -p /app/render-cache
chmod 700 /app/render-cache
chmod 700 /app/secrets

: "${INKER_INSTANCE_SECRET_PATH:=/app/secrets/instance.json}"
export INKER_INSTANCE_SECRET_PATH

# A missing secret is initialized only while the SQLite database is still absent.
# Existing databases fail closed and require restoration of their matching secret.
bun run scripts/prepare-instance-secrets.ts --initialize

# Apply versioned migrations before the application can become ready. With
# `set -e`, schema drift or a failed migration stops startup immediately.
bun run scripts/migrate-database.ts

# Execute the main command
exec "$@"
