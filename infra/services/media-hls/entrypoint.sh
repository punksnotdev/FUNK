#!/bin/sh
set -eu

: "${ICECAST_SOURCE_URL:?ICECAST_SOURCE_URL is required}"

HLS_DIR="${HLS_DIR:-/hls}"
SEGMENT_SECONDS="${SEGMENT_SECONDS:-6}"
PLAYLIST_SIZE="${PLAYLIST_SIZE:-6}"
FFMPEG_LOGLEVEL="${FFMPEG_LOGLEVEL:-warning}"

mkdir -p "$HLS_DIR"

run_ffmpeg() {
  ffmpeg \
    -hide_banner \
    -loglevel "$FFMPEG_LOGLEVEL" \
    -reconnect 1 \
    -reconnect_streamed 1 \
    -reconnect_delay_max 2 \
    -i "$ICECAST_SOURCE_URL" \
    -vn \
    -filter_complex "[0:a]asplit=3[a64][a96][a128]" \
    -map "[a64]" -c:a:0 aac -b:a:0 64k -ac:a:0 2 -ar:a:0 48000 \
    -map "[a96]" -c:a:1 aac -b:a:1 96k -ac:a:1 2 -ar:a:1 48000 \
    -map "[a128]" -c:a:2 aac -b:a:2 128k -ac:a:2 2 -ar:a:2 48000 \
    -f hls \
    -master_pl_name master.m3u8 \
    -hls_time "$SEGMENT_SECONDS" \
    -hls_list_size "$PLAYLIST_SIZE" \
    -hls_flags delete_segments+append_list+independent_segments+program_date_time+temp_file \
    -hls_segment_filename "$HLS_DIR/%v_%06d.ts" \
    -var_stream_map "a:0,name:64k a:1,name:96k a:2,name:128k" \
    "$HLS_DIR/%v.m3u8"
}

while true; do
  rm -f "$HLS_DIR"/*.m3u8 "$HLS_DIR"/*.ts
  run_ffmpeg || true
  sleep 2
done
