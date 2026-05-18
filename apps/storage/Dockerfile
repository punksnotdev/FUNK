FROM oven/bun:1.2.7-alpine
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/storage/package.json ./apps/storage/

RUN bun install

COPY packages/shared ./packages/shared
COPY apps/storage ./apps/storage

WORKDIR /app/apps/storage
EXPOSE 4002
CMD ["bun", "run", "src/index.ts"]
