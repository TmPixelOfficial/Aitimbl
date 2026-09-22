#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 20+ не найден."; exit 1; }
[ -d node_modules ] || npm install
[ -f .env ] || cp .env.example .env
echo "TIMBLOGPLAY AI: http://localhost:3000"
node server.js
