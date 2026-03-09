#!/bin/bash
# Start the Rosetta Cards MCP server from compiled JS.
# Prerequisite: npm run build
cd "$(dirname "$0")/.."
node dist/server.js
