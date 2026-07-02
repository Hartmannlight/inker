#!/bin/bash

# Terminus Backend Quick Start Script

set -e

echo "🚀 Terminus Server - Quick Start"
echo "================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
  echo "No .env file found. Creating from .env.example..."
  cp .env.example .env
  echo "Created .env file"
  echo "Please edit .env and configure DATABASE_URL and JWT_SECRET"
  echo ""
  read -p "Press Enter after updating .env to continue..."
fi

# Check if node_modules exists
if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo "✅ Dependencies installed"
  echo ""
fi

# Generate Prisma Client
echo "🔧 Generating Prisma Client..."
npm run prisma:generate
echo "✅ Prisma Client generated"
echo ""

# Check if migrations exist
if [ ! -d prisma/migrations ]; then
  echo "📊 Running database migrations..."
  npm run prisma:migrate
  echo "✅ Migrations complete"
  echo ""
  
  echo "🌱 Seeding database..."
  npm run db:seed
  echo "✅ Database seeded"
  echo ""
else
  echo " Migrations already exist. Run 'npm run prisma:migrate' to update."
  echo ""
fi

echo "✨ Setup complete!"
echo ""
echo "Starting development server..."
echo "Press Ctrl+C to stop"
echo ""

npm run start:dev
