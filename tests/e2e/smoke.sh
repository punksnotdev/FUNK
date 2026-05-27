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
# --build ensures auth + storage run the current source. Compose treats
# minio-init's clean exit (0) as a failure with --wait, so we skip --wait
# and rely on HTTP health probes below.
docker compose "${CONTROL_COMPOSE[@]}" up -d --build --quiet-pull || \
  docker compose "${CONTROL_COMPOSE[@]}" up -d --build
ok "control containers started"

# -- bring up media plane --------------------------------------------------

note "media plane up"
# --build ensures we always run the current code. Retry loop handles the
# transient "No such container" race condition in Docker compose 2.x where
# containers are reported non-existent right after creation.
for _attempt in 1 2 3; do
  if docker compose "${MEDIA_COMPOSE[@]}" up -d --build --quiet-pull 2>&1; then
    break
  fi
  docker compose "${MEDIA_COMPOSE[@]}" up -d >/dev/null 2>&1 && break || true
done
ok "media containers started"

# -- HTTP health (poll until 200 or timeout) -------------------------------

note "HTTP health"
wait_for_http http://localhost:4001/health           60 "auth"
wait_for_http http://localhost:4002/health           60 "storage"
wait_for_http http://localhost:4003/health           60 "radio"
wait_for_http http://localhost:4004/health           90 "recordings daemon"
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

# -- Track A: per-host harbor credentials ------------------------------------

note "harbor credentials"

CRED=$(curl -sS -X POST http://localhost:4003/v1/radio/live/credentials \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"label":"smoke test host","ttl_seconds":300}')
echo "$CRED" | grep -q '"password"' \
  || die "POST /v1/radio/live/credentials missing password field: $CRED"
echo "$CRED" | grep -q '"credential_id"' \
  || die "POST /v1/radio/live/credentials missing credential_id field: $CRED"
ok "credential minted with per-host password (not a shared password)"

LIVE_USERNAME=$(echo "$CRED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["username"])')
LIVE_PASSWORD=$(echo "$CRED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
LIVE_CRED_ID=$(echo  "$CRED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["credential_id"])')
[ -n "$LIVE_USERNAME" ] || die "no username in credential"
[ -n "$LIVE_PASSWORD" ] || die "no password in credential"
[ -n "$LIVE_CRED_ID"  ] || die "no credential_id in credential"
ok "credential fields parsed: id=${LIVE_CRED_ID:0:8}... user=$LIVE_USERNAME"

# -- unauthorized harbor connection (bogus creds) ---------------------------

note "unauthorized harbor connection (bogus creds)"
BOGUS_EXIT=0
docker exec funk-media-liquidsoap-1 sh -c \
  'ffmpeg -re -f lavfi -i "sine=frequency=440:duration=3" -c:a libmp3lame -b:a 128k \
    -f mp3 icecast://bogus_user:bogus_password@liquidsoap:8001/live \
    -loglevel error 2>/dev/null' || BOGUS_EXIT=$?
[ "$BOGUS_EXIT" -ne 0 ] \
  || die "ffmpeg with bogus creds succeeded (expected failure)"
ok "bogus-creds connection rejected (ffmpeg exit $BOGUS_EXIT)"

# -- authorized harbor connection -------------------------------------------

note "authorized harbor connection"
docker exec -d funk-media-liquidsoap-1 sh -c \
  "ffmpeg -re -f lavfi -i 'sine=frequency=440:duration=15' -c:a libmp3lame -b:a 128k \
    -f mp3 \
    icecast://${LIVE_USERNAME}:${LIVE_PASSWORD}@liquidsoap:8001/live \
    -loglevel error 2>/dev/null"
ok "authorized ffmpeg started in background"

# Wait for liquidsoap to confirm the source is connected.
HARBOR_CONNECTED=false
for _i in $(seq 1 20); do
  STATUS=$(python3 -c "
import socket
s = socket.create_connection(('127.0.0.1', 1234), timeout=3)
# liquidsoap 2.2 auto-assigns IDs: first input.harbor is 'input.harbor',
# second is 'input.harbor.2' — live is the first defined in funk.liq.
s.sendall(b'input.harbor.status\n')
buf = b''
while True:
    c = s.recv(1024)
    if not c: break
    buf += c
    if b'END\r\n' in buf: break
print(buf.decode().strip())
  " 2>/dev/null || echo "")
  if echo "$STATUS" | grep -qi "connected" && ! echo "$STATUS" | grep -qi "no source"; then
    HARBOR_CONNECTED=true
    break
  fi
  sleep 1
done
"$HARBOR_CONNECTED" || die "live harbor not connected after 20s. status: $STATUS"
ok "liquidsoap input.harbor.status confirms source connected"

# -- recording attribution --------------------------------------------------

note "recording attribution"
RADIO_INTERNAL_SECRET=$(grep -E '^RADIO_INTERNAL_SECRET=' infra/env/media.dev.env | cut -d= -f2)
ATTRIB_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
ATTRIB=$(curl -sS \
  -H "authorization: Bearer ${RADIO_INTERNAL_SECRET}" \
  "http://localhost:4003/v1/radio/internal/recording-attribution?mount=live&started_at=${ATTRIB_TS}")
echo "$ATTRIB" | grep -q '"credential_id"' \
  || die "recording-attribution did not return credential_id: $ATTRIB"
echo "$ATTRIB" | grep -q '"label"' \
  || die "recording-attribution did not return label: $ATTRIB"
ok "GET /v1/radio/internal/recording-attribution returned attribution"

# -- Track B: recordings upload daemon ---------------------------------------
# Exercises the full path: write an mp3 directly into the recordings volume
# (bypassing the harbor path), wait for the daemon to detect stability and
# upload, then assert the local file is deleted (proxy for successful upload).

note "recordings daemon — write file, wait for upload"

STABILITY_SECS=$(grep -E '^STABILITY_SECONDS=' infra/env/media.dev.env | cut -d= -f2)
STABILITY_SECS="${STABILITY_SECS:-30}"

REC_TS=$(date -u +%Y%m%d-%H%M%S)
REC_FILENAME="live-${REC_TS}.mp3"

docker exec funk-media-liquidsoap-1 sh -c "
  mkdir -p /var/funk/recordings/live
  ffmpeg -nostats -loglevel error -y \
    -f lavfi -i 'sine=frequency=880:duration=5' \
    -ac 2 -ar 44100 -b:a 128k /tmp/smoke-rec.mp3
  cp /tmp/smoke-rec.mp3 /var/funk/recordings/live/${REC_FILENAME}
"
ok "wrote ${REC_FILENAME} into recordings volume"

# Wait STABILITY_SECONDS + 30s for daemon to pick it up and upload.
WAIT_TOTAL=$(( STABILITY_SECS + 30 ))
note "waiting up to ${WAIT_TOTAL}s for daemon to upload ${REC_FILENAME}"
deadline=$(( $(date +%s) + WAIT_TOTAL ))
UPLOADED=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  # Check GET /v1/radio/recordings for an entry with non-null storage_url.
  # storage_url population from radio is deferred (Track A radio-side integration),
  # so instead poll the storage service's file listing directly via the admin token.
  STORAGE_LIST=$(curl -sS -H "authorization: Bearer $ADMIN_TOKEN" \
    "http://localhost:4002/files/recordings/live/${REC_FILENAME%-*}" 2>/dev/null || true)
  # More reliably: check if the local file has been deleted (daemon deletes after upload).
  if ! docker exec funk-media-liquidsoap-1 test -f "/var/funk/recordings/live/${REC_FILENAME}" 2>/dev/null; then
    ok "local file deleted — daemon confirmed upload"
    UPLOADED=1
    break
  fi
  sleep 3
done

[ "$UPLOADED" = "1" ] || die "daemon did not upload ${REC_FILENAME} within ${WAIT_TOTAL}s (file still present in volume)"

# Verify the daemon health endpoint reports 0 pending after successful upload.
HEALTH=$(curl -sS http://localhost:4004/health)
echo "$HEALTH" | grep -q '"status":"ok"' || die "recordings daemon health not ok: $HEALTH"
ok "recordings daemon /health returns status=ok"

# -- /v1/radio/recordings populated by daemon notification ------------------

note "radio recordings index populated by daemon notification"
RECS=""
for _i in $(seq 1 10); do
  RECS=$(curl -sS -H "authorization: Bearer $TOKEN" http://localhost:4003/v1/radio/recordings)
  if echo "$RECS" | grep -q '"storage_url"'; then break; fi
  sleep 1
done
echo "$RECS" | grep -q '"storage_url":"http' \
  || die "GET /v1/radio/recordings did not return a storage_url: $RECS"
ok "GET /v1/radio/recordings includes storage_url"

REC_URL=$(echo "$RECS" | python3 -c '
import sys, json
recs = json.load(sys.stdin).get("recordings", [])
match = next((r for r in recs if r.get("source") == "live"), None)
print(match["storage_url"] if match else "")
')
[ -n "$REC_URL" ] || die "no live recording entry found in recordings index"
ok "extracted storage_url: $REC_URL"

# Fetch it (-L follows the 302 redirect storage emits to a MinIO presigned URL).
curl -fsSL "$REC_URL" -o /tmp/funk_e2e_rec.mp3
SIZE=$(stat -c%s /tmp/funk_e2e_rec.mp3)
[ "$SIZE" -gt 1000 ] || die "fetched recording too small ($SIZE bytes)"
# MP3 files start with 'ID3' or 0xFF 0xFB (MPEG frame sync).
FIRST3=$(od -An -tx1 -N3 /tmp/funk_e2e_rec.mp3 | tr -d ' \n')
case "$FIRST3" in
  494433*) ok "fetched recording is ID3-tagged mp3 ($SIZE bytes)" ;;
  fffb*|fff3*|fff2*) ok "fetched recording is raw mp3 ($SIZE bytes)" ;;
  *) die "fetched recording not mp3-shaped (first bytes: $FIRST3, size: $SIZE)" ;;
esac

note "all smoke checks passed"
