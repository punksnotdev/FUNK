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
# liquidsoap via telnet on port 1234.

settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

settings.log.file := false
settings.log.stdout := true
settings.log.level := 3

# Pre-uploaded shows. funk-radio rewrites this file on PUT /v1/radio/schedule
# and tells liquidsoap to reload via telnet.
main = playlist(reload_mode="watch", "/etc/funk/schedule.m3u")

# Live host transmission. Hosts connect with a credential minted via
# POST /v1/radio/live/credentials; the password is rotated by funk-radio
# (see apps/radio/). For v0 a single shared harbor password is used.
live = input.harbor(
  "live",
  port=8001,
  password=environment.get("HARBOR_LIVE_PASSWORD")
)

# Breaking-news live takeover (separate mount, distinct credential).
breaking = input.harbor(
  "breaking",
  port=8002,
  password=environment.get("HARBOR_BREAKING_PASSWORD")
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
  "/var/funk/recordings/live/live-%Y%m%d-%H%M%S.mp3",
  fallible=true,
  reopen_when={ false },
  live
)

output.file(
  %mp3(bitrate=128),
  "/var/funk/recordings/breaking/breaking-%Y%m%d-%H%M%S.mp3",
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
