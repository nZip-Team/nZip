ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown

FROM golang:1.26-alpine AS core-builder

ARG VERSION

WORKDIR /workspace/Core

COPY Core /workspace/Core

RUN go build -trimpath -ldflags="-s -w -X 'main.Version=${VERSION}'" -o nzip-core .

FROM oven/bun:1.4-alpine AS nzip-builder

WORKDIR /workspace

COPY . /workspace

RUN bun run build

FROM oven/bun:1.4-alpine

ARG VERSION
ARG REVISION
ARG CREATED

LABEL org.opencontainers.image.url="https://ghcr.io/nzip-team/nzip"
LABEL org.opencontainers.image.source="https://github.com/nZip-Team/nZip"
LABEL org.opencontainers.image.title="nZip"
LABEL org.opencontainers.image.description="Download doujinshis from nhentai.net as a zip archive."
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision="${REVISION}"
LABEL org.opencontainers.image.created="${CREATED}"

WORKDIR /workspace

COPY --from=core-builder /workspace/Core/nzip-core /workspace/nzip-core
COPY --from=nzip-builder /workspace/dist /workspace

RUN bun install --production && rm -rf /root/.bun/install/cache

EXPOSE 3000

# Mount a volume here to keep sessions, the archive index and running downloads
RUN mkdir -p /workspace/Cache

HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3   CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["sh", "start.sh"]
