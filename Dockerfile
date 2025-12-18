FROM oven/bun:alpine AS builder

WORKDIR /workspace

COPY . /workspace

RUN bun run build

FROM oven/bun:alpine

LABEL org.opencontainers.image.url="https://ghcr.io/nzip-team/nzip"
LABEL org.opencontainers.image.source="https://github.com/nZip-Team/nZip"
LABEL org.opencontainers.image.title="nZip"
LABEL org.opencontainers.image.description="Download doujinshis from nhentai.net as a zip archive."
LABEL org.opencontainers.image.version="1.11.0"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision=""
LABEL org.opencontainers.image.created="2025-12-18T06:17:27.735Z"

WORKDIR /workspace

COPY --from=builder /workspace/dist /workspace

EXPOSE 3000

CMD ["start.sh"]
