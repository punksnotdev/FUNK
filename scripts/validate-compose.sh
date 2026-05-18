#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ok() { echo "  OK $1"; }
fail() { echo "  FAIL $1"; exit 1; }

ensure_env() {
  local plane="$1"
  local env_file="infra/env/${plane}.dev.env"
  if [[ ! -f "$env_file" ]]; then
    echo "  (creating $env_file from example)"
    cp "infra/env/${plane}.dev.env.example" "$env_file"
  fi
}

validate() {
  local plane="$1"
  ensure_env "$plane"
  local env_file="infra/env/${plane}.dev.env"
  local base="infra/compose/compose.${plane}.yml"
  local override="infra/compose/compose.${plane}.dev.override.yml"

  echo "validating ${plane} plane..."
  if docker compose --env-file "$env_file" -f "$base" -f "$override" config > /dev/null 2>&1; then
    ok "compose.${plane}.yml + override"
  else
    docker compose --env-file "$env_file" -f "$base" -f "$override" config
    fail "compose.${plane}.yml + override"
  fi
}

validate control
validate media
echo "all compose files valid"
