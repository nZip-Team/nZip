# nZip

nZip is a convenient tool for downloading doujinshi from nhentai.net as a zip archive.

## How to Use

1. **Modify the URL**: To download a doujinshi, simply replace `.net` with `.zip` in the URL. For example, to download the doujinshi at [https://nhentai.net/g/228922](https://nhentai.net/g/228922), you would navigate to [https://nhentai.zip/g/228922](https://nhentai.zip/g/228922).
   
2. **Direct ID Input**: Alternatively, you can enter the doujinshi ID directly on the nZip homepage to generate your zip archive.

## Development

nZip is built using TypeScript and Node.js. To run the project locally, clone the repository and execute the following commands after configuring the `Options.json` file:

```bash
npm install
npm run start
```

> [!IMPORTANT]
> You will also need to set up a nhentai API Server to get the images. You can find the code [here](./API/Main.ts).

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for more details.