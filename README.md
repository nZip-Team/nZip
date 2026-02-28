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

- `bun run dev:docker` - Build and run the development Docker stack
- `bun run build:core` - Build the Go core binary manually

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more details.
