import { ZipFile } from 'yazl'
import crypto from 'crypto'
import path from 'path'
import fs from 'fs'

import nhget, { type GalleryData } from '@icebrick/nhget'
import FileDownloader from '@icebrick/file-downloader'
import Log from '@icebrick/log'

import { getIP } from './Server'

import type { Context } from 'hono'
import type { BlankEnv, BlankInput } from 'hono/types'
import type { WSContext, WSEvents } from 'hono/ws'
import type { ServerWebSocket } from 'bun'

export default class WebSocketHandler {
  private nh: nhget
  private imageHost: string
  private activeDownloads: Map<string, FileDownloader>

  constructor(nh: nhget, imageHost: string) {
    this.nh = nh
    this.imageHost = imageHost
    this.activeDownloads = new Map()
  }

  /**
   * Safely remove a directory if it exists
   * @param dirPath Path to the directory to remove
   */
  private rmDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        let attempts = 0
        const maxAttempts = 3

        const tryRemove = () => {
          try {
            fs.rmSync(dirPath, { recursive: true, force: true })
            return true
          } catch (error) {
            attempts++
            if (attempts < maxAttempts) {
              setTimeout(tryRemove, 500)
            } else {
              Log.error(`Failed to remove directory ${dirPath} after ${maxAttempts} attempts: ${error}`)
            }
            return false
          }
        }

        tryRemove()
      }
    } catch (error) {
      Log.error(`Failed to check/remove directory ${dirPath}: ${error}`)
    }
  }

  /**
   * Handle WebSocket connections for downloading galleries
   * @param c Context containing request and response information
   * @returns WebSocket events
   */
  public handle(c: Context<BlankEnv, '/ws/g/:id', BlankInput>): WSEvents<ServerWebSocket> {
    const timestamp = Date.now()
    let downloadCompleted = false
    let downloader: FileDownloader | null = null
    const isClosedRef = { value: false }

    const id = c.req.param('id')
    const hash = crypto.createHash('md5').update(id).update(timestamp.toString()).digest('hex')

    const ip = getIP(c)

    return {
      onMessage: () => {
        // Do not expect any messages from the client
      },

      onOpen: async (_evt, ws) => {
        try {
          const response: GalleryData = (await this.nh.get(id)) as GalleryData

          if (response.error) {
            ws.close(1008, 'Resource Not Found')
            return
          }

          Log.info(`WS Download Start: ${response.id} - ${ip}`)
          fs.mkdirSync(path.join(__dirname, 'Cache', 'Downloads', hash), { recursive: true })

          const images = response.images.pages.map((page, index) => {
            const extension = page.t === 'j' ? 'jpg' : page.t === 'g' ? 'gif' : page.t === 'w' ? 'webp' : 'png'
            return `${this.imageHost}/galleries/${response.media_id}/${index + 1}.${extension}`
          })

          const galleryId = response.id
          const title = response.title.english || response.title.japanese || response.title.pretty || null
          let filename = title ? title.replace(/[/\\?%*:|"<>]/g, '_') : null
          if (title) {
            filename = `[${galleryId}] ${filename}.zip`
          } else {
            filename = `${galleryId}.zip`
          }

          let retry = 0
          let success = false

          while (success === false && retry < 3 && !isClosedRef.value) {
            success = await this.download(
              images,
              hash,
              ws,
              filename,
              (fd) => {
                downloader = fd
                this.activeDownloads.set(hash, fd)
              },
              isClosedRef
            )
            if (success === false) {
              retry++
            } else {
              break
            }
          }

          if (isClosedRef.value) {
            return
          }

          if (success === true) {
            downloadCompleted = true
            this.activeDownloads.delete(hash)
            Log.info(`WS Download End: ${response.id} - ${ip}`)

            ws.send(Buffer.concat([Buffer.from([0x20]), Buffer.from(`/download/${hash}/${filename}`)]))
            ws.close()

            fs.readdirSync(path.join(__dirname, 'Cache', 'Downloads', hash)).forEach((file) => {
              if (file !== filename) {
                fs.unlinkSync(path.join(__dirname, 'Cache', 'Downloads', hash, file))
              }
            })

            setTimeout(() => this.rmDir(path.join(__dirname, 'Cache', 'Downloads', hash)), 3e5)
          } else {
            Log.error(`Failed to download gallery: ${response.id}`)
            this.activeDownloads.delete(hash)
            ws.send(Buffer.from([0x20]))
            ws.close(1011, 'Internal Server Error')

            this.rmDir(path.join(__dirname, 'Cache', 'Downloads', hash))
          }
        } catch (error) {
          Log.error(`Error in WebSocket handler: ${error}`)
          this.activeDownloads.delete(hash)
          ws.close(1011, 'Internal Server Error')
        }
      },

      onClose: async () => {
        isClosedRef.value = true

        if (downloader && !downloadCompleted) {
          Log.info(`Stopping download: ${ip} - ${id}`)
          await downloader.stop()
          this.activeDownloads.delete(hash)

          await new Promise((resolve) => setTimeout(resolve, 3000))

          if (!downloadCompleted) {
            Log.info(`Cleaning up unfinished download: ${ip} - ${id}`)
            const downloadPath = path.join(__dirname, 'Cache', 'Downloads', hash)

            await new Promise((resolve) => setTimeout(resolve, 1000))
            this.rmDir(downloadPath)
          }
        }
      }
    }
  }

  /**
   * Download images from the given URLs
   * @param images URLs of the images to download
   * @param hash Hash of the gallery
   * @param ws WebSocket connection
   * @param filename Filename of the zip file
   * @param setDownloader Callback to set the downloader instance
   * @param isClosedRef Reference to isClosed flag that tracks WebSocket state
   */
  private async download(images: string[], hash: string, ws: WSContext<ServerWebSocket>, filename: string, setDownloader: (downloader: FileDownloader) => void, isClosedRef: { value: boolean }): Promise<boolean> {
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

      let isStopped = false

      downloader.on('progress', (completed, total) => {
        if (ws.readyState === 1) {
          // OPEN
          const buffer = Buffer.alloc(1 + 2 + 2)

          buffer[0] = 0x00
          buffer.writeUint16BE(completed, 1)
          buffer.writeUint16BE(total, 3)

          ws.send(buffer)
        } else {
          if (!isStopped) {
            isStopped = true
            downloader.stop()
          }
        }
      })

      try {
        await downloader.download([{ urls: images }])
      } catch (error) {
        if (ws.readyState === 1) {
          ws.send(Buffer.from([0x01]))
          ws.close()
        }

        this.rmDir(path.join(__dirname, 'Cache', 'Downloads', hash))
        resolve(false)
        return
      }

      if (isStopped || ws.readyState !== 1) {
        resolve(false)
        return
      }

      if (isClosedRef.value) {
        resolve(false)
        return
      }

      if (ws.readyState === 1) {
        // OPEN
        try {
          const buffer = Buffer.alloc(1 + 2 + 2)

          buffer[0] = 0x10
          buffer.writeUint16BE(0, 1)
          buffer.writeUint16BE(images.length, 3)

          ws.send(buffer)

          const zipFilePath = path.join(__dirname, 'Cache', 'Downloads', hash, filename)
          const downloadDir = path.join(__dirname, 'Cache', 'Downloads', hash)

          if (!fs.existsSync(downloadDir)) {
            ws.send(Buffer.from([0x11]))
            ws.close()
            resolve(false)
            return
          }

          const existingFiles: string[] = []
          for (const url of images) {
            const filePath = path.join(__dirname, 'Cache', 'Downloads', hash, path.basename(url))
            if (fs.existsSync(filePath)) {
              existingFiles.push(filePath)
            }
          }

          if (existingFiles.length === 0) {
            ws.send(Buffer.from([0x11]))
            ws.close()
            this.rmDir(path.join(__dirname, 'Cache', 'Downloads', hash))
            resolve(false)
            return
          }

          const zipfile = new ZipFile()
          const output = fs.createWriteStream(zipFilePath)

          output.on('error', (err) => {
            Log.error(`Error writing zip file: ${err}`)
            if (ws.readyState === 1) {
              ws.send(Buffer.from([0x11]))
              ws.close()
            }
            this.rmDir(path.join(__dirname, 'Cache', 'Downloads', hash))
            resolve(false)
          })

          zipfile.outputStream.pipe(output).on('close', () => {
            resolve(true)
          })

          for (const filePath of existingFiles) {
            if (isClosedRef.value) {
              Log.info('Connection closed during zip creation, aborting')
              zipfile.end()
              resolve(false)
              return
            }

            if (fs.existsSync(filePath)) {
              try {
                zipfile.addFile(filePath, path.basename(filePath))
              } catch (err) {
                Log.error(`Error adding file to zip: ${err}`)
              }
            } else {
              Log.warn(`File no longer exists, skipping: ${filePath}`)
            }
          }

          zipfile.end()
        } catch (err) {
          Log.error(`Error creating zip: ${err}`)
          if (ws.readyState === 1) {
            ws.send(Buffer.from([0x11]))
            ws.close()
          }

          this.rmDir(path.join(__dirname, 'Cache', 'Downloads', hash))
          resolve(false)
        }
      }
    })
  }
}

/**
 * 0x00 Download progress
 * 0x01 Download error
 * 0x10 Pack progress
 * 0x11 Pack error
 * 0x20 Download link
 */
