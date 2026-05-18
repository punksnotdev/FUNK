FROM alpine:3.20

RUN apk add --no-cache ca-certificates ffmpeg

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME ["/hls"]

ENTRYPOINT ["/entrypoint.sh"]
