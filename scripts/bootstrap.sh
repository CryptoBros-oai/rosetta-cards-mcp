#!/usr/bin/env bash
set -euo pipefail

echo "[1/5] Checking Node..."
command -v node >/dev/null 2>&1 || { echo "Node.js is required (node not found). Install Node 18+ and retry."; exit 1; }
echo "  Node $(node -v)"

echo "[2/5] Installing npm deps..."
npm install

echo "[3/5] Installing Playwright Chromium (may take a bit)..."
npx playwright install chromium

echo "[4/5] Setting up Python venv..."
python3 -m venv .venv 2>/dev/null || echo "  (Python venv already exists or python3 not available)"

echo "[5/5] Creating data directories..."
mkdir -p data/docs data/cards data/index data/bundles data/pinsets

echo ""
echo "Done! Available commands:"
echo "  npm run dev     - Start MCP server (stdio)"
echo "  npm run tui     - Launch TUI card browser"
echo "  npm run build   - Compile TypeScript"
