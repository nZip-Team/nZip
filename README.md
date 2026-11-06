# nZip

nZip is a convenient tool for downloading doujinshi from nhentai.net as an archive.

> [!WARNING]
> This project is not affiliated with or endorsed by nhentai.net. Please use it responsibly.
> This project is intended for educational purposes only and should not be used for any other purposes.

## How to Use

1. **Modify the URL**: To download a doujinshi, simply replace `.net` with `.zip` in the URL. For example, to download the doujinshi at `https://nhentai.net/g/228922`, you would navigate to `https://nhentai.zip/g/228922`.

2. **Direct ID Input**: Alternatively, you can enter the doujinshi ID directly on the nZip homepage to generate your archive.

   Anything else you type there is a search (same syntax as nhentai, e.g. `artist:x language:english -tag:y`), served by the API at `API_URL`.

3. **Download the Archive**: Once you have entered the URL or ID, it will automatically fetch the images and prepare the archive. nZip supports `zip`, `cbz`, `pdf`, and `epub` downloads.

## How nZip Works?

nZip makes a downloadable archive from a gallery code you provide. Here is the simple flow:

- You enter a code to request a download.
- If a ready-made archive already exists for that code, nZip returns the download link right away.
- If not, nZip fetches the gallery images, downloads them, and packs them into a zip file.
- While that work is happening you see progress updates in your browser so you know what's happening.
- When the zip is ready, nZip gives you a link to download it.
- You can also choose `cbz`, `pdf`, or `epub` from the download page.
- The archive is kept temporarily on the server and removed after a short time to save space. With an S3 bucket configured, finished archives are kept there instead, so the next request for the same gallery is ready at once; they are evicted after `ARCHIVE_RETENTION_DAYS` without a download, and the least recently downloaded go first once the bucket passes `ARCHIVE_MAX_GB`.
- Pages the image host no longer has are left out, and the download page says how many; a gallery with no pages left cannot be downloaded. Such incomplete archives are not kept in S3, since the pages may come back.
- If something goes wrong, nZip shows a clear error message and you can try again.

That's it - enter a code, watch progress, and download the archive in the format you want.

## Running the Project

### Using Docker

Install Docker (if you haven't already) with the following curl or wget:

```bash
curl -o- https://get.docker.com | bash
```

```bash
wget -qO- https://get.docker.com | bash
```

Next, create a directory for the Docker configuration files:

```bash
mkdir nzip
cd nzip
```

Then, copy the [compose.yml](compose.yml) file into the `nzip` directory.

Copy the [.env.example](.env.example) file into the `nzip` directory and rename it to `.env`, then open it in your favorite text editor and configure the environment variables.

To run in cluster mode, uncomment the `command` line in [compose.yml](compose.yml) and set the worker count.

Then, run the following command to run the Docker container:

```bash
docker compose up
```

Or use the following command to run the container in the background:

```bash
docker compose up -d
```

The nZip service should now be running on port 3000.

The `nzip-cache` volume holds the session database, the archive index and downloads in progress, so they survive restarts, image updates and rebuilds.

The container starts as root only to hand that volume to the unprivileged `bun` user (volumes from images before 1.15.4 hold root-owned files), then runs as `bun`.

### Configuration

Every variable lives in `.env`.

| Variable | Default | What it does |
| --- | --- | --- |
| `HOST` | `http://localhost:3000` | Public origin used to build download links |
| `PORT` | `3000` | Port the server listens on |
| `API_URL` | — | **Required.** Gallery API, absolute URL |
| `IMAGE_URL` | — | **Required.** Image host, absolute URL |
| `CONCURRENT_IMAGE_DOWNLOADS` | `16` | Parallel image fetches per gallery |
| `RATE_LIMIT` | `10` | WebSocket upgrades per minute per client; `0` disables |
| `SEARCH_RATE_LIMIT` | `20` | Searches per minute per client, after a burst of 1.5× this; `0` disables |
| `SEARCH_HOURLY_LIMIT` | `300` | Searches per hour per client; `0` disables |
| `TRUST_X_FORWARDED_FOR` | `false` | Read the client address from trusted proxies |
| `TRUSTED_PROXIES` | — | Comma-separated IPs or CIDRs of those proxies |
| `LOG_CLIENT_IP` | `false` | Log raw client IPs instead of salted hash tags |
| `LOG_CLIENT_SALT` | random | Keeps the hash tags stable across restarts and instances |
| `LOG_FORMAT` | `text` | `json` writes one JSON object per log line |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PREFIX` | — | Keep finished archives in S3; without `S3_BUCKET` they stay on local disk |
| `S3_VIRTUAL_HOSTED_STYLE` | `false` | Address the bucket as `bucket.endpoint` instead of `endpoint/bucket` |
| `ARCHIVE_RETENTION_DAYS` | `7` | Days without a download before an archive is evicted from S3 (`0` = never) |
| `ARCHIVE_MAX_GB` | `0` | Size cap for S3 archives, least recently downloaded go first (`0` = no cap) |
| `DRAIN_TIMEOUT_SECONDS` | `60` | How long a stopping instance lets running downloads finish; the whole shutdown takes up to this + 25 s, so keep `stop_grace_period` above that |
| `ANALYTICS` | — | HTML inserted into `<head>` as is |
| `CONTENT_SECURITY_POLICY` | derived | Policy of the pages; by default it allows `API_URL`, `IMAGE_URL` and the URLs in `ANALYTICS`. A full policy replaces it, `off` sends none |
| `NZIP_RUN_AS_ROOT` | `false` | Docker only: keep running as root instead of the `bun` user |
| `NODE_ENV` | `development` | `development` (live reload) or `production` |

A number that does not parse (say `RATE_LIMIT=1O`) stops the start with an error naming the variable.

**Behind a reverse proxy or CDN, set `TRUST_X_FORWARDED_FOR=true` and `TRUSTED_PROXIES`**, or every request appears to come from the proxy and all visitors share one rate-limit bucket. List only the proxies themselves: a catch-all such as `0.0.0.0/0` lets anyone pick their own address. Behind Cloudflare the address comes from `CF-Connecting-IP`; otherwise it is the last `X-Forwarded-For` entry that is not a trusted proxy.

A gallery page accepts `?format=zip|cbz|pdf|epub` to preselect the archive format.

### Updating without downtime

[compose.ha.yml](compose.ha.yml) runs two instances that share the cache volume behind Caddy ([Caddyfile](Caddyfile)). Start it with `docker compose -f compose.ha.yml up -d`, and update with:

```bash
sh Scripts/rolling-update.sh
```

The stack also runs two `cloudflared` connectors for a Cloudflare Tunnel: create a remotely managed tunnel, point its public hostname at `http://nzip-lb:80`, and set `TUNNEL_TOKEN` in `.env`. Remove the `cloudflared` service if you put nZip behind something else.

It replaces one instance at a time. A stopping instance fails its `/healthz` check, lets running downloads finish for up to `DRAIN_TIMEOUT_SECONDS` (archive downloads already sending get 15 s more), then hands the rest over: browsers reconnect on their own and the other instance resumes from the images already downloaded. `/healthz` also fails while the Go core does not answer.

Caddy listens twice: `:80` is for `cloudflared` only and is not published, so the `CF-Connecting-IP` it receives is Cloudflare's; `:81` is the LAN port (`NZIP_PORT`, default 3000), which drops `CF-Connecting-IP` and `X-Forwarded-For`, so nobody on the LAN can claim another client's address.

Cleanup jobs (orphaned download directories, archive eviction, the index rebuild) run on one instance at a time: they hold a lease in `Cache/leases.db` on the shared volume, and the other instance takes over when the holder stops.

### Metrics

`/metrics` serves Prometheus metrics, but only to requests that did not come through Cloudflare (no `CF-Connecting-IP`) from private addresses. Behind [compose.ha.yml](compose.ha.yml) scrape each instance through the LAN port:

```yaml
scrape_configs:
  - job_name: nzip
    metrics_path: /metrics/nzip-a # and a second target with /metrics/nzip-b
    static_configs:
      - targets: ['docker-host:3000']
```

Among them: `nzip_ws_sessions`, `nzip_ws_clients`, `nzip_downloads_in_flight`, `nzip_download_streams_active`, `nzip_core_restarts_total`, `nzip_core_up`, `nzip_s3_requests_total` and `nzip_s3_request_duration_seconds`, `nzip_archive_evicted_bytes_total`, `nzip_archive_lookups_total{result="hit|miss"}`, `nzip_rate_limited_total{kind="search|ws_upgrade|ws_message"}`, `nzip_metadata_cache_total` and `nzip_http_requests_total{route,method,status}`. Requests for `/healthz` and `/metrics` are not logged.

WebSocket rate limits are kept per instance; Caddy sends one URL to one instance, and `/search` per client, so in practice a client meets one set of limits.

### Using Bun

Follow the instructions in the [Development](#development) section to run the project locally.

## Development

nZip is built using [TypeScript](https://www.typescriptlang.org/), [Bun](https://bun.sh/), and a Go core process.

### Requirements

- [Bun](https://bun.sh/)
- [Go](https://go.dev/)

### Run locally

Clone the repository and execute the following commands after configuring the `.env` file:

```bash
bun install
bun start
```

### Optional scripts

- `bun test` - Run the server tests in `Tests/` (`cd Core && go test ./...` for the core)
- `bun run typecheck` - Type check
- `bun run dev:docker` - Build and run the development Docker stack
- `bun run build:core` - Build the Go core binary manually

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more details.
