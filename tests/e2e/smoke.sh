#!/usr/bin/env bash
# End-to-end smoke test for the FUNK dev stack.
#
# Brings up both planes, mints a credential, applies a schedule,
# confirms liquidsoap switches off the noise fallback, and verifies
# the HLS pipeline is producing valid MPEG-TS segments.
#
# Local:  bash tests/e2e/smoke.sh           # keeps stack up for inspection
# CI:     KEEP_STACK=0 bash tests/e2e/smoke.sh   # tears down on exit
#
# Exit code 0 = all checks passed. Any failure aborts immediately.

set -euo pipefail

cd "$(dirname "$0")/../.."

KEEP_STACK="${KEEP_STACK:-1}"

note() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
die()  { printf "  \033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

# wait_for_http <url> <timeout-seconds> <label>
wait_for_http() {
  local url="$1" deadline=$(( $(date +%s) + ${2:-60} )) label="${3:-$1}"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$url" || echo 000)" = "200" ]; then
      ok "$label ready"
      return 0
    fi
    sleep 1
  done
  die "$label never returned 200 within ${2:-60}s"
}

CONTROL_COMPOSE=(--env-file infra/env/control.dev.env
  -f infra/compose/compose.control.yml
  -f infra/compose/compose.control.dev.override.yml)
MEDIA_COMPOSE=(--env-file infra/env/media.dev.env
  -f infra/compose/compose.media.yml
  -f infra/compose/compose.media.dev.override.yml)

teardown() {
  if [ "$KEEP_STACK" = "0" ]; then
    note "tearing down (KEEP_STACK=0)"
    docker compose "${MEDIA_COMPOSE[@]}"   down -v >/dev/null 2>&1 || true
    docker compose "${CONTROL_COMPOSE[@]}" down -v >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

# -- prereqs ---------------------------------------------------------------

note "prereqs"
docker network create funk_dev >/dev/null 2>&1 || true
ok "shared dev network funk_dev present"

cp -f infra/env/control.dev.env.example infra/env/control.dev.env
cp -f infra/env/media.dev.env.example   infra/env/media.dev.env
ok "env files refreshed from .example"

ADMIN_TOKEN=$(grep -E '^ADMIN_BOOTSTRAP_TOKEN=' infra/env/control.dev.env | cut -d= -f2)
[ -n "$ADMIN_TOKEN" ] || die "ADMIN_BOOTSTRAP_TOKEN missing from control.dev.env"

# -- bring up control plane (clean volumes for deterministic schema init) --

note "control plane up (clean volumes)"
docker compose "${CONTROL_COMPOSE[@]}" down -v >/dev/null 2>&1 || true
# We deliberately omit `--wait`: compose treats minio-init's clean exit (0)
# as a failure with --wait, and we'd rather check HTTP health ourselves.
docker compose "${CONTROL_COMPOSE[@]}" up -d --quiet-pull
ok "control containers started"

# -- bring up media plane --------------------------------------------------

note "media plane up"
docker compose "${MEDIA_COMPOSE[@]}" up -d --quiet-pull
ok "media containers started"

# -- HTTP health (poll until 200 or timeout) -------------------------------

note "HTTP health"
wait_for_http http://localhost:4001/health           60 "auth"
wait_for_http http://localhost:4002/health           60 "storage"
wait_for_http http://localhost:4003/health           60 "radio"
wait_for_http http://localhost:8000/status-json.xsl  60 "icecast"
# HLS master takes a moment after liquidsoap starts pushing audio.
wait_for_http http://localhost:8080/hls/master.m3u8  90 "hls origin"

# -- auth flow -------------------------------------------------------------

note "auth flow"
MINT=$(curl -sS -X POST http://localhost:4001/v1/credentials \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"e2e-smoke"}')
TOKEN=$(echo "$MINT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] || die "no token in mint response: $MINT"
ok "credential minted"

ME=$(curl -sS -H "authorization: Bearer $TOKEN" http://localhost:4001/v1/credentials/me)
echo "$ME" | grep -q '"label":"e2e-smoke"' \
  || die "/v1/credentials/me did not echo credential: $ME"
ok "/v1/credentials/me echoes credential"

# Cross-plane: radio (media) must validate the same token via auth (control).
radio_401=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer bogus_token_for_negative_check" \
  http://localhost:4003/v1/radio/schedule)
[ "$radio_401" = "401" ] || die "radio accepted bogus token (got $radio_401)"
ok "radio rejects bogus token (401)"

# -- prepare audio source --------------------------------------------------

note "prepare test audio inside liquidsoap"
docker exec funk-media-liquidsoap-1 sh -c '
  if ! command -v ffmpeg >/dev/null 2>&1; then
    apt-get update -qq >/dev/null && apt-get install -y -qq ffmpeg >/dev/null
  fi
  ffmpeg -nostats -loglevel error -y \
    -f lavfi -i "sine=frequency=440:duration=60" \
    -ac 2 -ar 44100 -b:a 128k /tmp/test.mp3
' >/dev/null
ok "60s sine generated at /tmp/test.mp3"

# -- apply schedule --------------------------------------------------------

note "apply schedule"
APPLIED=$(curl -sS -X PUT http://localhost:4003/v1/radio/schedule \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"entries":[{"audio_url":"file:///tmp/test.mp3","title":"smoke","starts_at":"2026-05-26T18:50:00Z","ends_at":"2026-05-26T19:00:00Z"}]}')
echo "$APPLIED" | grep -q '"applied":true' || die "schedule not applied: $APPLIED"
ok "PUT /v1/radio/schedule returned applied=true"

# Read it back.
SCHED=$(curl -sS -H "authorization: Bearer $TOKEN" http://localhost:4003/v1/radio/schedule)
echo "$SCHED" | grep -q '"audio_url":"file:///tmp/test.mp3"' \
  || die "GET schedule did not echo the URL we just PUT: $SCHED"
ok "GET schedule echoes applied entries"

# -- confirm liquidsoap switched off noise ---------------------------------

note "liquidsoap state via telnet"
sleep 5
ON_AIR=$(python3 - <<'PY'
import socket
s = socket.create_connection(("127.0.0.1", 1234), timeout=5)
s.sendall(b"request.on_air\n")
buf = b""
while True:
    c = s.recv(1024)
    if not c: break
    buf += c
    if b"END\r\n" in buf: break
print(buf.decode().strip())
PY
)
# When `noise()` is on-air there is no request; we expect at least one rid.
if echo "$ON_AIR" | grep -Eq '^[[:space:]]*[0-9]+'; then
  ok "main source on-air (request.on_air: $(echo "$ON_AIR" | head -1))"
else
  die "no on-air request — switch did not flip off noise. output: $ON_AIR"
fi

# -- HLS pipeline ----------------------------------------------------------

note "HLS pipeline"
sleep 2
SEG1=$(curl -s http://localhost:8080/hls/128k.m3u8 | grep -c '\.ts$' || true)
sleep 7
SEG2=$(curl -s http://localhost:8080/hls/128k.m3u8 | grep -c '\.ts$' || true)
[ "$SEG1" -gt 0 ] || die "no HLS segments after applying schedule"
ok "HLS sliding window present (saw $SEG1 → $SEG2 segments across 7s)"

# Fetch a segment and verify it's MPEG-TS shaped.
SEG=$(curl -s http://localhost:8080/hls/128k.m3u8 | awk '/\.ts$/{print; exit}')
[ -n "$SEG" ] || die "no .ts entry in 128k.m3u8"
curl -fsS "http://localhost:8080/hls/$SEG" -o /tmp/funk_e2e_seg.ts
# MPEG-TS sync byte is 0x47 at offset 0, repeating every 188 bytes.
FIRST=$(od -An -tx1 -N1 /tmp/funk_e2e_seg.ts | tr -d ' \n')
[ "$FIRST" = "47" ] || die "segment $SEG missing MPEG-TS sync byte (got $FIRST)"
ok "fetched segment $SEG starts with valid MPEG-TS sync byte"

# -- icecast source state --------------------------------------------------

note "icecast funk.mp3 mount"
SOURCE_INFO=$(curl -s http://localhost:8000/status-json.xsl)
echo "$SOURCE_INFO" | grep -q '"listenurl":"http://localhost:8000/funk.mp3"' \
  || die "icecast funk.mp3 mount not active. response: $SOURCE_INFO"
ok "icecast reports funk.mp3 mount with active source"

note "all smoke checks passed"
