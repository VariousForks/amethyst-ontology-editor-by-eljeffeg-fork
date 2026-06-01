# ---------- Stage 1: build client ----------
FROM node:25-alpine AS client-build

WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build


# ---------- Stage 2: install server deps ----------
FROM node:25-alpine AS server-build

# Build deps only if you have native modules
RUN apk add --no-cache make g++ gcc

WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/ ./


# ---------- Stage 3: runtime ----------
FROM node:25-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
# SQLITE_DIR is intentionally not set here. The entrypoint defaults it
# based on whether Litestream is configured: /tmp (tmpfs) when Litestream
# replicates to object storage, otherwise DATA_DIR (the persistent volume).
# Set SQLITE_DIR explicitly to override.

ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.11

# Minimal runtime packages
# wget is needed to download Litestream since there is no Alpine package.
RUN apk upgrade --no-cache && \
    apk add --no-cache ca-certificates git wget

# Litestream — replicates SQLite to GCS for durability across restarts.
# There is currently no Alpine package for Litestream, so we download 
# the binary directly from GitHub releases. Created an issue to request:
# https://github.com/benbjohnson/litestream/issues/1266
RUN if [ "$TARGETARCH" = "arm64" ] || [ "$TARGETARCH" = "aarch64" ]; then \
        LS_ARCH="arm64"; \
    else \
        LS_ARCH="x86_64"; \
    fi && \
    echo "Downloading Litestream v${LITESTREAM_VERSION} for ${LS_ARCH}" && \
    wget -qO /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${LS_ARCH}.tar.gz" && \
    tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && \
    rm /tmp/litestream.tar.gz

# Update npm packages to get latest security patches
RUN npm install -g npm@latest && \
    npm update -g

WORKDIR /app

RUN mkdir -p /app/data /app/client /app/server && \
    chown -R node:node /app

COPY --from=server-build --chown=node:node /app/server /app/server
COPY --from=client-build --chown=node:node /app/client/dist /app/client/dist
COPY --chown=node:node examples/ /app/examples/
COPY --chown=root:root litestream.yml /etc/litestream.yml
COPY --chown=root:root --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

WORKDIR /app/server
USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]