# nZip

nZip is a convenient tool for downloading doujinshi from nhentai.net as a zip archive.

> [!WARNING]
> This project is not affiliated with or endorsed by nhentai.net. Please use it responsibly.
> This project is intended for educational purposes only and should not be used for any other purposes.

## How to Use

1. **Modify the URL**: To download a doujinshi, simply replace `.net` with `.zip` in the URL. For example, to download the doujinshi at `https://nhentai.net/g/228922`, you would navigate to `https://nhentai.zip/g/228922`.

2. **Direct ID Input**: Alternatively, you can enter the doujinshi ID directly on the nZip homepage to generate your zip archive.

3. **Download the Archive**: Once you have entered the URL or ID, it will automatically fetch the images and download the archive.

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

Then, create a `compose.yml` file in the `nzip` directory with the following content:

```yaml
services:
  nzip-server:
    container_name: nzip-server
    image: ghcr.io/nzip-team/nzip:latest
    ports:
      - '3000:3000'
    environment:
      - HOST=${HOST}
      - PORT=${PORT}
      - API_URL=${API_URL}
      - IMAGE_URL=${IMAGE_URL}
      - CONCURRENT_IMAGE_DOWNLOADS=${CONCURRENT_IMAGE_DOWNLOADS}
      - ANALYTICS=${ANALYTICS}
      - NODE_ENV=${NODE_ENV}
    network_mode: bridge
    restart: unless-stopped
```

Create a `.env` file and configure the environment variables:

```sh
# Set the host and port for the nZip server (Host is the URL where the server will be accessible)
HOST=http://localhost:3000
PORT=3000

# Both API_URL and IMAGE_URL must be set to start the server
API_URL=
IMAGE_URL=

# Number of concurrent image downloads for each download session (default: 16)
CONCURRENT_IMAGE_DOWNLOADS=16

# Optional
ANALYTICS=

# Set to production if you want to run the server in production mode
NODE_ENV=development
```

Then, run the following command to run the Docker container:

```bash
docker compose up
```

Or use the following command to run the container in the background:

```bash
docker compose up -d
```

The nZip service should now be running on port 3000.

### Using Bun

Follow the instructions in the [Development](#development) section to run the project locally.

## Development

nZip is built using TypeScript and [Bun](https://bun.sh/). To run the project locally, clone the repository and execute the following commands after configuring the `.env` file:

```bash
bun install
bun start
```

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more details.
