#!/usr/bin/env bash
# Sobe os fontes para o GoDeploy. Uso: scripts/deploy.sh <uploadToken>
set -euo pipefail
cd "$(dirname "$0")/.."
curl -s -X POST https://mcp.devgogroup.com/upload \
  -H "Authorization: Bearer $1" \
  -F "package.json=@./package.json" \
  -F "src/worker.js=@./src/worker.js" \
  -F "src/engine.js=@./src/engine.js" \
  -F "src/db.js=@./src/db.js"
