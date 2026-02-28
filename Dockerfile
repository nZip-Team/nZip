FROM golang:1.26-alpine AS core-builder

WORKDIR /workspace/Core

COPY Core /workspace/Core

RUN go build -ldflags="-s -w" -o nzip-core .

FROM oven/bun:alpine AS nzip-builder

WORKDIR /workspace

COPY . /workspace

RUN bun run build

FROM oven/bun:alpine

LABEL org.opencontainers.image.url="https://ghcr.io/nzip-team/nzip"
LABEL org.opencontainers.image.source="https://github.com/nZip-Team/nZip"
LABEL org.opencontainers.image.title="nZip"
LABEL org.opencontainers.image.description="Download doujinshis from nhentai.net as a zip archive."
LABEL org.opencontainers.image.version="1.13.0-beta"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision=""
LABEL org.opencontainers.image.created="2026-02-24T06:26:13.368Z"

WORKDIR /workspace

COPY --from=core-builder /workspace/Core/nzip-core /workspace/nzip-core
COPY --from=nzip-builder /workspace/dist /workspace

EXPOSE 3000

CMD ["sh", "start.sh"]
