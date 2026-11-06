ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown

# Build stages run on the runner's own platform and cross-compile, so multi-arch builds avoid QEMU
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS core-builder

ARG VERSION
ARG TARGETOS
ARG TARGETARCH

WORKDIR /workspace/Core

COPY Core/go.mod Core/go.sum ./
RUN go mod download

COPY Core ./

RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X 'main.Version=${VERSION}'" -o nzip-core .

FROM --platform=$BUILDPLATFORM oven/bun:1.4-alpine AS nzip-builder

WORKDIR /workspace

COPY . /workspace

RUN bun run build && cd dist && bun install --production && rm -rf /root/.bun/install/cache

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

# Mount a volume here to keep sessions, the archive index and running downloads
RUN mkdir -p /workspace/Cache

COPY --from=nzip-builder /workspace/dist /workspace
COPY --from=core-builder /workspace/Core/nzip-core /workspace/nzip-core

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=60s --retries=3   CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["sh", "start.sh"]
