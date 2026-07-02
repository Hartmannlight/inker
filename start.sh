#!/bin/bash

set -e

echo "Starting Inker..."
echo ""

# Check if .env exists, if not copy from .env.example
if [ -f .env.example ] && [ ! -f .env ]; then
    echo "Creating .env file from .env.example..."
    cp .env.example .env
    echo "Edit .env to customize settings."
    echo ""
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "Docker is not running. Please start Docker and try again."
    exit 1
fi

# Pull latest images and start container
echo "Starting Inker container..."
docker compose pull 2>/dev/null || true
docker compose up -d

echo ""
echo "Waiting for Inker to be healthy..."

# Wait for container to be healthy
for i in {1..30}; do
    if docker ps | grep -q "inker.*healthy"; then
        echo "Inker is healthy!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "Inker failed to start. Check logs with: docker compose logs"
        exit 1
    fi
    echo "  Waiting... ($i/30)"
    sleep 2
done

echo ""
echo "Inker is running!"
echo ""
echo "  URL:          http://localhost"
echo "  Default PIN:  1111"
echo ""
echo "Commands:"
echo "  View logs:    docker compose logs -f"
echo "  Stop:         docker compose down"
echo "  Restart:      docker compose restart"
echo ""
