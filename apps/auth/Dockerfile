FROM oven/bun:1.2.7-alpine
WORKDIR /app

# Bring workspace root + lockfile + this app's manifest first for caching.
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/auth/package.json ./apps/auth/

RUN bun install

COPY packages/shared ./packages/shared
COPY apps/auth ./apps/auth

WORKDIR /app/apps/auth
EXPOSE 4001
CMD ["bun", "run", "src/index.ts"]
