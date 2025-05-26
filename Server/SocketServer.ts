import { WebSocketServer, WebSocket } from 'ws'
import { ZipFile } from 'yazl'
import crypto from 'crypto'
import http from 'http'
import path from 'path'
import fs from 'fs'

import nhget, { type GalleryData } from '@icebrick/nhget'
import FileDownloader from '@icebrick/file-downloader'
import Log from '@icebrick/log'

/**
 * Start the WebSocket server
 * @param httpServer HTTP server
 * @param apiHost API host
 * @param imageHost Image host
 */
export default (httpServer: http.Server, apiHost: string, imageHost: string): void => {
  const nh = new nhget({
    endpoint: `${apiHost}/api/gallery/`,
    imageEndpoint: `${imageHost}/galleries/`
  })

  const server = new WebSocketServer({ server: httpServer })

  server.on('connection', async (socket, req) => {
    const forwardedFor = req.headers['x-forwarded-for']
    const ip = Array.isArray(forwardedFor) ? forwardedFor[0].trim() : forwardedFor?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
    const url = req.url
    
    const timestamp = Date.now()

    let downloadCompleted = false

    let hash: string | null = null
    if (url && url.substring(0, 3) === '/g/') {
      hash = crypto.createHash('md5').update(url.substring(3)).update(timestamp.toString()).digest('hex')
    }

    let downloader: FileDownloader | null = null

    socket.on('close', () => {
      if (downloader) {
        downloader.stop()
      }
      
      if (!downloadCompleted && hash) {
        const downloadPath = path.join(__dirname, 'Cache', 'Downloads', hash)
        if (fs.existsSync(downloadPath)) {
          Log.info(`Cleaning up unfinished download: ${ip} - ${url?.substring(3) || 'unknown gallery'}`)
          try {
            fs.rmSync(downloadPath, { recursive: true })
          } catch (error) {
            Log.error(`Failed to clean up unfinished download: ${downloadPath}`)
          }
        }
      }
    })

    if (url && hash) {
      const response: GalleryData = (await nh.get(url.substring(3))) as GalleryData

      if (response.error) {
        socket.close(404, 'Resource Not Found')
      } else {
        Log.info(`WS Download Start: ${response.id} - ${ip}`)
        fs.mkdirSync(path.join(__dirname, 'Cache', 'Downloads', hash), { recursive: true })

        const images = response.images.pages.map((page, index) => {
          const extension = page.t === 'j' ? 'jpg' : page.t === 'g' ? 'gif' : page.t === 'w' ? 'webp' : 'png'
          return `${imageHost}/galleries/${response.media_id}/${index + 1}.${extension}`
        })

        const id = response.id
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        let filename = title ? title.replace(/[/\\?%*:|"<>]/g, '_') : null
        if (title) {
          filename = `[${id}] ${filename}.zip`
        } else {
          filename = `${id}.zip`
        }

        let retry = 0
        let success = false

        while (success === false && retry < 3) {
          success = await download(images, hash, socket, filename, (fd) => { downloader = fd })
          if (success === false) {
            retry++
          } else {
            break
          }
        }

        if (success === true) {
          downloadCompleted = true
          Log.info(`WS Download End: ${response.id} - ${ip}`)

          socket.send(Buffer.concat([Buffer.from([0x20]), Buffer.from(`/download/${hash}/${filename}`)]))
          socket.close()

          fs.readdirSync(path.join(__dirname, 'Cache', 'Downloads', hash)).forEach(file => {
            if (file !== filename) {
              fs.unlinkSync(path.join(__dirname, 'Cache', 'Downloads', hash, file))
            }
          })

          setTimeout(() => fs.rmSync(path.join(__dirname, 'Cache', 'Downloads', hash), { recursive: true }), 3e5)
        } else {
          Log.error(`Failed to download gallery: ${response.id}`)
          socket.send(Buffer.from([0x20]))
          socket.close(500, 'Internal Server Error')

          fs.rmSync(path.join(__dirname, 'Cache', 'Downloads', hash), { recursive: true })
        }
      }
    }
  })
}

/**
 * Download images from the given URLs
 * @param images URLs of the images to download
 * @param hash Hash of the gallery
 * @param socket WebSocket connection
 * @param filename Filename of the zip file
 * @param setDownloader Callback to set the downloader instance
 */
async function download(images: string[], hash: string, socket: WebSocket, filename: string, setDownloader: (downloader: FileDownloader) => void): Promise<boolean> {
  return new Promise(async (resolve, _) => {
    const urlCount = images.length
    const concurrentDownloads = Math.min(urlCount, 16)

    const downloader = new FileDownloader({
      concurrentDownloads,
      maxRetries: 10,
      downloadDir: path.join(__dirname, 'Cache', 'Downloads', hash),
      timeout: 5000,
      debug: process.env['NODE_ENV'] === 'development'
    })
    
    setDownloader(downloader)

    downloader.on('progress', (completed, total) => {
      if (socket.readyState === socket.OPEN) {
        const buffer = Buffer.alloc(1 + 2 + 2)

        buffer[0] = 0x00
        buffer.writeUint16BE(completed, 1)
        buffer.writeUint16BE(total, 3)

        socket.send(buffer)
      }
    })

    try {
      await downloader.download([{ urls: images }])
    } catch (error) {
      socket.send(Buffer.from([0x01]))
      socket.close()

      fs.rmSync(path.join(__dirname, 'Cache', 'Downloads', hash), { recursive: true })
    }

    if (socket.readyState === socket.OPEN) {
      try {
        const buffer = Buffer.alloc(1 + 2 + 2)

        buffer[0] = 0x10
        buffer.writeUint16BE(0, 1)
        buffer.writeUint16BE(images.length, 3)

        socket.send(buffer)

        const zipFilePath = path.join(__dirname, 'Cache', 'Downloads', hash, filename)

        const zipfile = new ZipFile()
        const output = fs.createWriteStream(zipFilePath)

        zipfile.outputStream.pipe(output).on('close', () => {
          resolve(true)
        })

        for (const url of images) {
          const filePath = path.join(__dirname, 'Cache', 'Downloads', hash, path.basename(url))
          zipfile.addFile(filePath, path.basename(url))
        }

        zipfile.end()
      } catch (_) {
        socket.send(Buffer.from([0x11]))
        socket.close()

        fs.rmSync(path.join(__dirname, 'Cache', 'Downloads', hash), { recursive: true })
      }
    }
  })
}

/**
 * 0x00 Download progress
 * 0x01 Download error
 * 0x10 Pack progress
 * 0x11 Pack error
 * 0x20 Download link
 */
