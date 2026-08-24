#!/bin/sh
set -e

# Create all required directories
mkdir -p /app/uploads/screens
mkdir -p /app/uploads/firmware
mkdir -p /app/uploads/widgets
mkdir -p /app/uploads/captures
mkdir -p /app/uploads/drawings
mkdir -p /app/logs

# Apply versioned migrations before the application can become ready. With
# `set -e`, schema drift or a failed migration stops startup immediately.
bun run scripts/migrate-database.ts

# Execute the main command
exec "$@"
