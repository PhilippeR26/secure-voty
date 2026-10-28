#!/usr/bin/env bash
# SNIP-36 proof server — entry point. Run: ./proof-server.sh help
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "node not found: install Node.js 22 or newer (see INSTALL.md)" >&2
  exit 1
fi
if [[ ! -f "$DIR/dist/cli/main.js" ]]; then
  echo "Not built yet: run 'npm install && npm run build' in $DIR" >&2
  exit 1
fi
exec node "$DIR/dist/cli/main.js" "$@"
