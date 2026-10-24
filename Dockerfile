# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.source="https://github.com/ccxxpa/file-transfer-assistant" \
    org.opencontainers.image.description="Self-hosted file and text sharing across your devices" \
    org.opencontainers.image.licenses="GPL-3.0-only"

WORKDIR /app
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY assistant/server.js ./assistant/server.js
COPY assistant/public/ ./assistant/public/
COPY deploy/docker-entrypoint.sh deploy/healthcheck.js ./deploy/
COPY LICENSE ./LICENSE
COPY licenses/ ./licenses/
RUN chmod 755 /app/deploy/docker-entrypoint.sh && mkdir -p /data

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4826 DATA_DIR=/data \
    MAX_FILE_MB=100 MAX_STORAGE_MB=5120 PUID=1000 PGID=1000
EXPOSE 4826
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "/app/deploy/healthcheck.js"]
ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
CMD ["node", "/app/assistant/server.js"]
