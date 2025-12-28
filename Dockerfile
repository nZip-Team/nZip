FROM oven/bun:alpine AS builder

WORKDIR /workspace

COPY . /workspace

RUN bun run build

FROM oven/bun:alpine

LABEL org.opencontainers.image.url="https://ghcr.io/nzip-team/nzip"
LABEL org.opencontainers.image.source="https://github.com/nZip-Team/nZip"
LABEL org.opencontainers.image.title="nZip"
LABEL org.opencontainers.image.description="Download doujinshis from nhentai.net as a zip archive."
LABEL org.opencontainers.image.version="1.11.1-beta"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision=""
LABEL org.opencontainers.image.created="2025-12-28T11:23:34.141Z"

WORKDIR /workspace

COPY --from=builder /workspace/dist /workspace

EXPOSE 3000

CMD ["start.sh"]
