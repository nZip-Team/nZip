# nZip

nZip is a convenient tool for downloading doujinshi from nhentai.net as a zip archive.

> [!WARNING]
> This project is not affiliated with or endorsed by nhentai.net. Please use it responsibly.
> This project is intended for educational purposes only and should not be used for any other purposes.

## How to Use

1. **Modify the URL**: To download a doujinshi, simply replace `.net` with `.zip` in the URL. For example, to download the doujinshi at [https://nhentai.net/g/228922](https://nhentai.net/g/228922), you would navigate to [https://nhentai.zip/g/228922](https://nhentai.zip/g/228922).
   
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

Next, clone the repository and navigate to the project directory:

```bash
git clone https://github.com/nZip-Team/nZip.git
cd nZip
```

Clone the `.env.example` file and rename it to `.env` and configure the environment variables:

```bash
cp .env.example .env
nano .env
```

Then, run the following command to run the Docker container:

```bash
docker compose up
```

Or use the following command to run the container in the background:

```bash
docker compose up -d
```

If you want to run the development version in docker, use the following command instead:
```bash
docker compose -f compose.dev.yml up --build
```

The nZip service should now be running on port 3000.

### Using Bun

Follow the instructions in the [Development](#development) section to run the project locally.

## Development

nZip is built using TypeScript and Bun. To run the project locally, clone the repository and execute the following commands after configuring the `.env` file:

With npm:
```bash
npm install -D
npm run start
```

With bun:
```bash
bun install
bun start
```

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more details.
