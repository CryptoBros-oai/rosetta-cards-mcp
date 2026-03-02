#!/usr/bin/env bash
set -euo pipefail

# Simple demo: seed the repo with sample artifacts and list outputs
echo "Installing dependencies..."
npm ci --silent

echo "Seeding sample data..."
npm run seed

echo "Listing created artifacts:"
ls -la data/cards || true
ls -la data/blobs || true
ls -la data/text || true

echo "Demo complete. Run 'npm run tui' to open the TUI."
