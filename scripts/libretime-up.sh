#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${ENV_FILE:-infra/env/media.dev.env}"

docker compose --env-file "$ENV_FILE" \
  -f infra/compose/compose.media.yml \
  -f infra/compose/compose.media.dev.override.yml \
  -f infra/compose/compose.media.libretime.yml \
  -f infra/compose/compose.media.libretime.dev.override.yml \
  up -d "$@"
