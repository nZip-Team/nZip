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
import type { WSEvents } from 'hono/ws'
import type { ServerWebSocket } from 'bun'

type StatusCacheKey = 'download' | 'pack' | 'link'

interface DownloadSession {
  id: string
  hash: string
  clients: Set<ServerWebSocket>
  downloader: FileDownloader | null
  downloadCompleted: boolean
  filename?: string
  lastDownloadBuffer?: Buffer
  lastPackBuffer?: Buffer
  lastLinkBuffer?: Buffer
  downloadLink?: string
  isAborting: boolean
  cleanupTimer?: ReturnType<typeof setTimeout>
  downloadPromise?: Promise<void>
}

export default class WebSocketHandler {
  private nh: nhget
  private imageHost: string
  private activeDownloads: Map<string, FileDownloader>
  private sessions: Map<string, DownloadSession>
  private concurrentImageDownloads: number
  private downloadDir: string

  constructor(nh: nhget, imageHost: string, downloadDir:string, concurrentImageDownloads: number) {
    this.nh = nh
    this.imageHost = imageHost
    this.concurrentImageDownloads = concurrentImageDownloads
    this.activeDownloads = new Map()
    this.sessions = new Map()

    this.downloadDir = downloadDir
  }

  /**
   * Generate a safe filename that doesn't exceed filesystem limits
   * @param galleryId Gallery ID
   * @param titles Object containing title options
   * @returns Sanitized filename within 255 bytes
   */
  private generateFilename(galleryId: string | number, titles: { english?: string; pretty?: string }): string {
    const sanitize = (text: string) => text.replace(/[/\\?%*:|"<>]/g, '_')
    const tryFilename = (title: string) => {
      const filename = `[${galleryId}] ${sanitize(title)}.zip`
      return Buffer.byteLength(filename) <= 255 ? filename : null
    }

    return (
      (titles.english && tryFilename(titles.english)) ||
      (titles.pretty && tryFilename(titles.pretty)) ||
      `${galleryId}.zip`
    )
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
    const id = c.req.param('id')
    const hash = crypto.createHash('md5').update(id).digest('hex')
    const ip = getIP(c)
    const wsRef: { current: ServerWebSocket | null } = { current: null }

    return {
      onMessage: () => {
        // Do not expect any messages from the client
      },

      onOpen: async (_evt, ws) => {
        const socket = ws.raw
        if (!socket) {
          ws.close(1011, 'Internal Server Error')
          return
        }
        wsRef.current = socket
        const session = this.getSession(id, hash)
        session.clients.add(socket)
        Log.info(`WS Client Join: ${id} - ${ip} (${session.clients.size})`)

        if (session.cleanupTimer) {
          clearTimeout(session.cleanupTimer)
          session.cleanupTimer = undefined
          Log.info(`WS Session Resume: ${id} - ${ip}`)
        }

        this.sendSnapshotToClient(session, socket)

        if (!session.downloadCompleted && !session.downloadPromise) {
          Log.info(`WS Flow Start: ${id} - ${ip}`)
          session.downloadPromise = this.startDownloadFlow(id, session, ip).finally(() => {
            session.downloadPromise = undefined
          })
        } else if (session.downloadPromise) {
          Log.info(`WS Flow In Progress: ${id} - ${ip}`)
        } else if (session.downloadCompleted) {
          Log.info(`WS Flow Replay: ${id} - ${ip}`)
        }
      },

      onClose: async () => {
        const ws = wsRef.current
        if (!ws) {
          return
        }

        const session = this.sessions.get(hash)
        if (!session) {
          return
        }

        await this.onSessionClose(session, ws, id, ip)
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
  private async download(images: string[], session: DownloadSession, filename: string): Promise<boolean> {
    return new Promise(async (resolve) => {
      const hash = session.hash
      const downloadDir = path.join(this.downloadDir, hash)
      const urlCount = images.length
      const concurrentImageDownloads = Math.min(urlCount, this.concurrentImageDownloads)

      const downloader = new FileDownloader({
        concurrentDownloads: concurrentImageDownloads,
        maxRetries: 10,
        downloadDir,
        timeout: 5000,
        debug: process.env['NODE_ENV'] === 'development'
      })

      session.downloader = downloader
      this.activeDownloads.set(hash, downloader)

      let isStopped = false

      const stopDownloads = () => {
        if (isStopped) {
          return
        }
        isStopped = true
        downloader.stop().catch((err) => {
          Log.warn(`Failed to stop downloader for ${hash}: ${err}`)
        })
      }

      downloader.on('progress', (completed, total) => {
        if (session.isAborting) {
          stopDownloads()
          return
        }

        const buffer = Buffer.alloc(1 + 2 + 2)
        buffer[0] = 0x00
        buffer.writeUint16BE(completed, 1)
        buffer.writeUint16BE(total, 3)

        this.broadcastToSession(session, buffer, 'download')
      })

      try {
        await downloader.download([{ urls: images }])
      } catch (error) {
        Log.error(`Downloader error for ${hash}: ${error}`)
        if (!session.isAborting) {
          this.signalSessionFailure(session, Buffer.from([0x01]), 1011, 'Internal Server Error')
        }
        resolve(false)
        return
      } finally {
        this.activeDownloads.delete(hash)
        session.downloader = null
      }

      if (isStopped || session.isAborting) {
        resolve(false)
        return
      }

      try {
        const buffer = Buffer.alloc(1 + 2 + 2)
        buffer[0] = 0x10
        buffer.writeUint16BE(0, 1)
        buffer.writeUint16BE(images.length, 3)
        this.broadcastToSession(session, buffer, 'pack')

        const zipFilePath = path.join(downloadDir, filename)

        if (!fs.existsSync(downloadDir)) {
          this.signalSessionFailure(session, Buffer.from([0x11]), 1011, 'Internal Server Error')
          resolve(false)
          return
        }

        const existingFiles: string[] = []
        for (const url of images) {
          const filePath = path.join(downloadDir, path.basename(url))
          if (fs.existsSync(filePath)) {
            existingFiles.push(filePath)
          }
        }

        if (existingFiles.length === 0) {
          this.signalSessionFailure(session, Buffer.from([0x11]), 1011, 'Internal Server Error')
          resolve(false)
          return
        }

        const zipfile = new ZipFile()
        const output = fs.createWriteStream(zipFilePath)

        output.on('error', (err) => {
          Log.error(`Error writing zip file for ${hash}: ${err}`)
          this.signalSessionFailure(session, Buffer.from([0x11]), 1011, 'Internal Server Error')
          resolve(false)
        })

        zipfile.outputStream
          .pipe(output)
          .on('close', () => {
            resolve(true)
          })

        for (const filePath of existingFiles) {
          if (session.isAborting) {
            Log.info(`Aborting zip creation for ${hash}`)
            zipfile.end()
            resolve(false)
            return
          }

          if (fs.existsSync(filePath)) {
            try {
              zipfile.addFile(filePath, path.basename(filePath))
            } catch (err) {
              Log.error(`Error adding file to zip for ${hash}: ${err}`)
            }
          } else {
            Log.warn(`File no longer exists for ${hash}, skipping: ${filePath}`)
          }
        }

        zipfile.end()
      } catch (err) {
        Log.error(`Error creating zip for ${hash}: ${err}`)
        this.signalSessionFailure(session, Buffer.from([0x11]), 1011, 'Internal Server Error')
        resolve(false)
      }
    })
  }

  private getSession(id: string | number, hash: string): DownloadSession {
    let session = this.sessions.get(hash)

    if (session) {
      Log.info(`WS Session Reuse: ${id}`)
      return session
    }

    Log.info(`WS Session Create: ${id} - ${hash}`)
    session = {
      id: id.toString(),
      hash,
      clients: new Set(),
      downloader: null,
      downloadCompleted: false,
      isAborting: false
    }

    this.sessions.set(hash, session)
    return session
  }

  private sendSnapshotToClient(session: DownloadSession, ws: ServerWebSocket): void {
    if (ws.readyState !== 1) {
      return
    }

    if (session.lastDownloadBuffer) {
      ws.send(session.lastDownloadBuffer)
    }

    if (session.lastPackBuffer) {
      ws.send(session.lastPackBuffer)
    }

    if (session.lastLinkBuffer) {
      ws.send(session.lastLinkBuffer)
      ws.close()
    }
  }

  private broadcastToSession(session: DownloadSession, buffer: Buffer, cache?: StatusCacheKey): void {
    if (cache === 'download') {
      session.lastDownloadBuffer = buffer
    } else if (cache === 'pack') {
      session.lastPackBuffer = buffer
    } else if (cache === 'link') {
      session.lastLinkBuffer = buffer
    }

    for (const client of Array.from(session.clients)) {
      if (client.readyState === 1) {
        try {
          client.send(buffer)
        } catch (error) {
          Log.warn(`Failed to send buffer to client in session ${session.hash}: ${error}`)
          session.clients.delete(client)
        }
      } else {
        session.clients.delete(client)
      }
    }
  }

  private broadcastDownloadLink(session: DownloadSession, filename: string): void {
    const link = `/download/${session.hash}/${encodeURIComponent(filename)}`
    session.downloadLink = link
    const buffer = Buffer.concat([Buffer.from([0x20]), Buffer.from(link)])
    this.broadcastToSession(session, buffer, 'link')
  }

  private closeSessionClients(session: DownloadSession, code = 1000, reason?: string): void {
    for (const client of Array.from(session.clients)) {
      try {
        client.close(code, reason)
      } catch (error) {
        Log.warn(`Failed to close client in session ${session.hash}: ${error}`)
      }
    }
  }

  private async onSessionClose(session: DownloadSession, ws: ServerWebSocket, id: string, ip: string): Promise<void> {
    session.clients.delete(ws)

    if (session.clients.size === 0) {
      Log.info(`WS Session Idle: ${id} - ${ip}`)
      const downloadPath = path.join(this.downloadDir, session.hash)
      this.scheduleSessionCleanup(session, downloadPath)
    }
  }

  private async startDownloadFlow(id: string, session: DownloadSession, ip: string): Promise<void> {
    const hash = session.hash

    try {
      const response: GalleryData = (await this.nh.get(id)) as GalleryData

      if (response.error) {
        session.isAborting = true
        this.closeSessionClients(session, 1008, 'Resource Not Found')
        this.sessions.delete(hash)
        return
      }

      Log.info(`WS Download Start: ${response.id} - ${ip}`)
      const downloadDir = path.join(this.downloadDir, hash)
      fs.mkdirSync(downloadDir, { recursive: true })

      const images = response.images.pages.map((page, index) => {
        const extension = page.t === 'j' ? 'jpg' : page.t === 'g' ? 'gif' : page.t === 'w' ? 'webp' : 'png'
        return `${this.imageHost}/galleries/${response.media_id}/${index + 1}.${extension}`
      })

      const filename = this.generateFilename(response.id, response.title)
      session.filename = filename

      let retry = 0
      let success = false

      while (!success && retry < 3 && !session.isAborting) {
        success = await this.download(images, session, filename)
        if (!success) {
          retry++
        }
      }

      if (session.isAborting) {
        return
      }

      if (success) {
        session.downloadCompleted = true
        Log.info(`WS Download End: ${response.id} - ${ip}`)
        this.broadcastDownloadLink(session, filename)
        this.closeSessionClients(session)
        this.cleanTempFiles(downloadDir, filename)
        this.scheduleSessionCleanup(session, downloadDir)
      } else {
        Log.error(`Failed to download gallery: ${response.id}`)
        this.signalSessionFailure(session, Buffer.from([0x20]), 1011, 'Internal Server Error')
      }
    } catch (error) {
      Log.error(`Error in WebSocket handler: ${error}`)
      this.signalSessionFailure(session, Buffer.from([0x20]), 1011, 'Internal Server Error')
    }
  }

  private cleanTempFiles(downloadDir: string, filename: string): void {
    try {
      fs.readdirSync(downloadDir).forEach((file) => {
        if (file !== filename) {
          try {
            fs.unlinkSync(path.join(downloadDir, file))
          } catch (error) {
            Log.warn(`Failed to delete temporary file ${file}: ${error}`)
          }
        }
      })
    } catch (error) {
      Log.warn(`Failed to enumerate download directory ${downloadDir}: ${error}`)
    }
  }

  private scheduleSessionCleanup(session: DownloadSession, downloadDir: string): void {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer)
    }

    session.cleanupTimer = setTimeout(() => {
      Log.info(`WS Session Timeout: ${session.id}`)

      if (session.downloader && !session.downloadCompleted) {
        session.isAborting = true
        session.downloader.stop().catch((error) => {
          Log.warn(`Failed to stop downloader during timeout for ${session.hash}: ${error}`)
        })
        this.activeDownloads.delete(session.hash)
      }

      this.rmDir(downloadDir)
      this.sessions.delete(session.hash)
      session.lastDownloadBuffer = undefined
      session.lastPackBuffer = undefined
      session.lastLinkBuffer = undefined
      session.downloadLink = undefined
      session.cleanupTimer = undefined
    }, 3e5)
  }

  private signalSessionFailure(session: DownloadSession, buffer: Buffer, closeCode: number, reason: string): void {
    if (session.isAborting) {
      return
    }

    session.isAborting = true
    this.broadcastToSession(session, buffer)
    this.closeSessionClients(session, closeCode, reason)

    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer)
      session.cleanupTimer = undefined
    }

    if (session.downloader) {
      session.downloader.stop().catch((error) => {
        Log.warn(`Failed to stop downloader during failure for ${session.hash}: ${error}`)
      })
      this.activeDownloads.delete(session.hash)
    }

    const downloadDir = path.join(this.downloadDir, session.hash)
    this.rmDir(downloadDir)
    this.sessions.delete(session.hash)
  }
}

/**
 * 0x00 Download progress
 * 0x01 Download error
 * 0x10 Pack progress
 * 0x11 Pack error
 * 0x20 Download link
 */
