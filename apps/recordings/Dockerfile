FROM oven/bun:1.2.7-alpine
# ffprobe for duration calculation; curl for healthcheck
RUN apk add --no-cache ffmpeg curl
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/recordings/package.json ./apps/recordings/

RUN bun install

COPY packages/shared ./packages/shared
COPY apps/recordings ./apps/recordings

WORKDIR /app/apps/recordings
EXPOSE 4004
CMD ["bun", "run", "src/index.ts"]
