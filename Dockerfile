ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown

FROM golang:1.26-alpine AS core-builder

ARG VERSION

WORKDIR /workspace/Core

COPY Core /workspace/Core

RUN go build -trimpath -ldflags="-s -w -X 'main.Version=${VERSION}'" -o nzip-core .

FROM oven/bun:alpine AS nzip-builder

WORKDIR /workspace

COPY . /workspace

RUN bun run build

FROM oven/bun:alpine

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

EXPOSE 3000

CMD ["sh", "start.sh"]
