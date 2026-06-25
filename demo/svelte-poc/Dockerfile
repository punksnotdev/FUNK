# FUNK admin demo (SvelteKit + adapter-node).
#
# PUBLIC_FUNK_HLS_URL is read via $env/static/public and therefore INLINED at
# build time — it must be supplied as a build ARG, not just a runtime env.
# Everything else (FUNK_*, DEMO_*) is $env/dynamic/private and read at runtime.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
ARG PUBLIC_FUNK_HLS_URL=http://localhost:7488/hls/master.m3u8
ENV PUBLIC_FUNK_HLS_URL=${PUBLIC_FUNK_HLS_URL}
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000 HOST=0.0.0.0
# Raise the adapter-node body limit so MP3 uploads (default cap is 512K) pass
# through to the storage service.
ENV BODY_SIZE_LIMIT=104857600
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "build"]
