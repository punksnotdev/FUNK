# FUNK media-plane audio engine (v0). See docs/adr/ADR-002.
#
# Priority chain (highest first):
#   1. breaking  — live-news takeover via input.harbor on port 8002
#   2. interrupt — one-shot clips pushed via telnet "interrupt.push <url>"
#   3. live      — scheduled-host transmission via input.harbor on port 8001
#   4. main      — playlist driven by /etc/funk/schedule.m3u
#   5. fallback  — white noise so listeners never hear absolute silence
#
# The funk-radio HTTPS service (apps/radio/) writes schedule.m3u and pokes
# liquidsoap via telnet on port 1234. It also owns the credential store that
# validates every harbor connection via POST /v1/radio/internal/harbor-auth.

settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

settings.log.file := false
settings.log.stdout := true
settings.log.level := 3

# Pre-uploaded shows. funk-radio rewrites this file on PUT /v1/radio/schedule
# and tells liquidsoap to reload via telnet.
main = playlist(id="main", reload_mode="watch", "/etc/funk/schedule.m3u")

# Zero-padded integer helper for ISO8601 timestamp construction.
def pad2(n) =
  s = "#{n}"
  if string.length(s) == 1 then "0#{s}" else s end
end

def now_iso8601() =
  t = time.utc()
  "#{t.year}-#{pad2(t.month)}-#{pad2(t.day)}T#{pad2(t.hour)}:#{pad2(t.min)}:#{pad2(t.sec)}Z"
end

# Recording filename timestamp: YYYYMMDD-HHMMSS (UTC). liquidsoap 2.2 does NOT
# strftime-expand output.file paths, so we build the stamp ourselves and pass
# the filename as a getter ({...}) below — evaluated each time the file opens,
# so every session gets its own connect-time name (e.g. live-20260613-110550.mp3).
# The recordings daemon parses started_at out of this exact shape.
def rec_stamp() =
  t = time.utc()
  "#{t.year}#{pad2(t.month)}#{pad2(t.day)}-#{pad2(t.hour)}#{pad2(t.min)}#{pad2(t.sec)}"
end

# Auth callback shared by both harbor sources. Receives a creds record
# {user, password, address} and POSTs to funk-radio, which validates the
# credential against its in-memory store.
def harbor_auth(~mount, creds) =
  resp = http.post(
    "http://radio:4003/v1/radio/internal/harbor-auth",
    headers=[
      ("Authorization", "Bearer #{environment.get('RADIO_INTERNAL_SECRET')}"),
      ("Content-Type", "application/json")
    ],
    data=json.stringify({
      mount=mount,
      username=creds.user,
      password=creds.password,
      connected_at=now_iso8601()
    })
  )
  if resp.status_code == 200 then
    parsed = json.parse(default={valid=false}, resp)
    parsed.valid
  else
    false
  end
end

# Disconnect hook shared by both harbor sources. Radio resolves the active
# credential_id internally by mount — on_disconnect has no credential context.
def harbor_disconnect(~mount) =
  ignore(http.post(
    "http://radio:4003/v1/radio/internal/harbor-disconnect",
    headers=[
      ("Authorization", "Bearer #{environment.get('RADIO_INTERNAL_SECRET')}"),
      ("Content-Type", "application/json")
    ],
    data=json.stringify({
      mount=mount,
      disconnected_at=now_iso8601()
    })
  ))
end

# Live host transmission. Hosts connect with a credential minted via
# POST /v1/radio/live/credentials; funk-radio validates each connection.
live = input.harbor(
  "live",
  port=8001,
  auth=fun(creds) -> harbor_auth(mount="live", creds),
  on_disconnect=fun() -> harbor_disconnect(mount="live")
)

# Breaking-news live takeover (separate mount, distinct credential).
breaking = input.harbor(
  "breaking",
  port=8002,
  auth=fun(creds) -> harbor_auth(mount="breaking", creds),
  on_disconnect=fun() -> harbor_disconnect(mount="breaking")
)

# One-shot interrupt queue. funk-radio pushes URLs here:
#   echo 'interrupt.push https://storage.../clip.mp3' | nc liquidsoap 1234
interrupt = request.queue(id="interrupt")

# Final fallback: white noise so the stream is never absolutely silent.
fallback_src = noise()

# Priority chain. track_sensitive=false → higher-priority sources cut in
# immediately rather than waiting for the current track to finish.
out = fallback(
  track_sensitive=false,
  [breaking, interrupt, live, main, fallback_src]
)

# Record live/breaking sessions for archive. File rotates each time the
# source connects/disconnects (open on connect, close on drop).
output.file(
  %mp3(bitrate=128),
  { "/var/funk/recordings/live/live-#{rec_stamp()}.mp3" },
  fallible=true,
  reopen_when={ false },
  live
)

output.file(
  %mp3(bitrate=128),
  { "/var/funk/recordings/breaking/breaking-#{rec_stamp()}.mp3" },
  fallible=true,
  reopen_when={ false },
  breaking
)

# Broadcast to icecast funk.mp3 mount.
output.icecast(
  %mp3(bitrate=128),
  host=environment.get("ICECAST_HOST"),
  port=8000,
  password=environment.get("ICECAST_SOURCE_PASSWORD"),
  mount="funk.mp3",
  name="FUNK Radio",
  description="FUNK community broadcast",
  out
)
