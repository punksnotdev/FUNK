#!/usr/bin/env bash
# Idempotent first-run setup for LibreTime in the FUNK media plane.
#
#   1. Ensures media.dev.env has LibreTime secrets (generates if missing)
#   2. Materializes infra/services/libretime/config.yml from template
#   3. Runs LibreTime DB migration (idempotent)
#   4. Pulls LibreTime images
#
# After this, bring the stack up with:
#   docker compose --env-file infra/env/media.dev.env \
#     -f infra/compose/compose.media.yml \
#     -f infra/compose/compose.media.dev.override.yml \
#     -f infra/compose/compose.media.libretime.yml \
#     -f infra/compose/compose.media.libretime.dev.override.yml \
#     up -d

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-infra/env/media.dev.env}"
ENV_EXAMPLE="infra/env/media.dev.env.example"
TEMPLATE="infra/services/libretime/config.template.yml"
CONFIG="infra/services/libretime/config.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> copying $ENV_EXAMPLE -> $ENV_FILE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
fi

ensure_var() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    echo "==> adding $key to $ENV_FILE"
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

rand_hex() { openssl rand -hex 16; }

ensure_var LIBRETIME_VERSION "4.5.0"
ensure_var LIBRETIME_POSTGRES_PASSWORD "$(rand_hex)"
ensure_var LIBRETIME_RABBITMQ_PASSWORD "$(rand_hex)"
ensure_var LIBRETIME_API_KEY "$(rand_hex)"
ensure_var LIBRETIME_SECRET_KEY "$(rand_hex)"
ensure_var LIBRETIME_PUBLIC_URL "http://localhost:8090"
ensure_var LIBRETIME_TIMEZONE "UTC"
ensure_var LIBRETIME_NGINX_HOST_PORT "8090"

echo "==> materializing $CONFIG from template"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
if ! command -v envsubst >/dev/null 2>&1; then
  echo "envsubst not found. Install gettext-base (Debian/Ubuntu) or gettext (macOS)." >&2
  exit 1
fi
envsubst < "$TEMPLATE" > "$CONFIG"

compose() {
  docker compose --env-file "$ENV_FILE" \
    -f infra/compose/compose.media.yml \
    -f infra/compose/compose.media.dev.override.yml \
    -f infra/compose/compose.media.libretime.yml \
    -f infra/compose/compose.media.libretime.dev.override.yml \
    "$@"
}

echo "==> pulling libretime images"
compose pull libretime-postgres libretime-rabbitmq libretime-api libretime-legacy libretime-nginx libretime-analyzer libretime-worker libretime-playout libretime-liquidsoap

echo "==> bringing up postgres + rabbitmq"
compose up -d libretime-postgres libretime-rabbitmq

echo "==> waiting for postgres healthy"
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' funk-media-libretime-postgres-1 2>/dev/null || echo "starting")
  [[ "$status" == "healthy" ]] && break
  sleep 2
done
[[ "$status" == "healthy" ]] || { echo "libretime-postgres failed to become healthy" >&2; exit 1; }

echo "==> running libretime-api migrate (idempotent)"
compose run --rm libretime-api libretime-api migrate

echo
echo "Setup complete. To start everything:"
echo "  bash scripts/libretime-up.sh"
echo
echo "Then open the LibreTime UI at: http://localhost:${LIBRETIME_NGINX_HOST_PORT}"
echo "Default credentials: admin / admin  (change immediately)"
