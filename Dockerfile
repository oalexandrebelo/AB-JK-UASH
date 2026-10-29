# The frontend is compiled once; the running SQLite application needs no npm
# installation, package registry, CDN, or downloaded runtime.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DB_PATH=/data/ab-jk-uash.sqlite \
    DIST_DIR=/app/dist \
    SETUP_TOKEN_FILE=/data/setup-token \
    NODE_OPTIONS=--max-old-space-size=320
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY --from=build /build/server ./server
COPY --from=build /build/scripts ./scripts
COPY --from=build /build/integrations ./integrations
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/licenses ./licenses
# Oficina can supply source files as 0640. Make runtime resources readable by
# the unprivileged process without depending on the source checkout's owner.
RUN chmod -R a+rX /app \
    && mkdir -p /data \
    && chown 1001:1001 /data \
    && chmod 0700 /data
USER 1001:1001
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "scripts/start.mjs"]
