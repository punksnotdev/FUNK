FROM oven/bun:1.2.7-alpine
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/radio/package.json ./apps/radio/

RUN bun install

COPY packages/shared ./packages/shared
COPY apps/radio ./apps/radio

WORKDIR /app/apps/radio
EXPOSE 4003
CMD ["bun", "run", "src/index.ts"]
