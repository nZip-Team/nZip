FROM oven/bun:alpine

WORKDIR /workspace

COPY . /workspace

RUN bun run build

FROM oven/bun:alpine

LABEL org.opencontainers.image.url="https://ghcr.io/nzip-team/nzip"
LABEL org.opencontainers.image.source="https://github.com/nZip-Team/nZip"
LABEL org.opencontainers.image.title="nZip"
LABEL org.opencontainers.image.description="Download doujinshis from nhentai.net as a zip archive."
LABEL org.opencontainers.image.version="1.9.2"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision=""
LABEL org.opencontainers.image.created=""

WORKDIR /workspace

COPY --from=0 /workspace/dist /workspace

EXPOSE 3000

CMD ["start.sh"]
