import path from 'path'
import fs from 'fs'
import os from 'os'
import { CronJob } from 'cron'

import nhget from '@icebrick/nhget'
import Log from './Modules/Log'
import type { DownloadResult, IDownloadManager, ISessionStore } from './Modules/Core'

import Config from '../Config'

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
  downloadCompleted: boolean
  filename?: string
  lastDownloadBuffer?: Buffer
  lastPackBuffer?: Buffer
  lastLinkBuffer?: Buffer
  downloadLink?: string
  isAborting: boolean
  lastAccessTime: number
  downloadPromise?: Promise<void>
  lockRefreshTimer?: ReturnType<typeof setInterval>
  lastDownloadPersistAt: number
}

export default class WebSocketHandler {
  private static readonly DOWNLOAD_STATUS_PERSIST_INTERVAL_MS = 1000
  private nh: nhget
  private imageHost: string
  private downloadManager: IDownloadManager
  private sessions: Map<string, DownloadSession>
  private sessionStore: ISessionStore
  private concurrentImageDownloads: number
  private downloadDir: string
  private processID: string
  private cleanupCron?: CronJob
  private initialCleanupTimer?: ReturnType<typeof setTimeout>

  constructor(nh: nhget, downloadDir: string, sessionStore: ISessionStore, downloadManager: IDownloadManager) {
    this.nh = nh
    this.imageHost = Config.imageHost
    this.concurrentImageDownloads = Config.concurrentImageDownloads
    this.downloadManager = downloadManager
    this.sessions = new Map()
    this.sessionStore = sessionStore

    this.downloadDir = downloadDir

    this.processID = `${os.hostname()}-${process.pid}-${Date.now()}`

    this.startOrphanedDownloadsCleanup()
  }

  /**
   * Generate a safe filename that doesn't exceed filesystem limits
   * @param galleryID Gallery ID
   * @param titles Object containing title options
   * @returns Sanitized filename within 255 bytes
   */
  private generateFilename(galleryID: string | number, titles: { english?: string; pretty?: string }): string {
    const sanitize = (text: string) => text.replace(/[/\\?%*:|"<>]/g, '_')
    const tryFilename = (title: string) => {
      const filename = `[${galleryID}] ${sanitize(title)}.zip`
      return Buffer.byteLength(filename) <= 255 ? filename : null
    }

    return (
      (titles.english && tryFilename(titles.english)) ||
      (titles.pretty && tryFilename(titles.pretty)) ||
      `${galleryID}.zip`
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
        let retryTimer: ReturnType<typeof setTimeout> | null = null

        const cleanup = () => {
          if (retryTimer) {
            clearTimeout(retryTimer)
            retryTimer = null
          }
        }

        const tryRemove = () => {
          try {
            fs.rmSync(dirPath, { recursive: true, force: true })
            cleanup()
            return true
          } catch (error) {
            attempts++
            if (attempts < maxAttempts) {
              retryTimer = setTimeout(tryRemove, 500)
            } else {
              cleanup()
              Log.error(`Failed to remove directory ${dirPath} after ${maxAttempts} attempts: ${error}`)
              const hash = path.basename(dirPath)
              if (this.sessions.has(hash)) {
                const session = this.sessions.get(hash)!
                session.lastDownloadBuffer = undefined
                session.lastPackBuffer = undefined
                session.lastLinkBuffer = undefined
                session.downloadLink = undefined
                session.filename = undefined
                session.clients.clear()
                this.sessions.delete(hash)
              }
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
   * Ensure a completed session still has its zip on disk; otherwise reset state
   */
  private async ensureZipExists(session: DownloadSession): Promise<boolean> {
    if (!session.downloadCompleted || !session.filename) {
      return true
    }

    const zipPath = path.join(this.downloadDir, session.hash, session.filename)
    if (fs.existsSync(zipPath)) {
      return true
    }

    Log.warn(`WS Missing Zip Reset: ${session.id} - ${session.filename}`)

    session.downloadCompleted = false
    session.downloadLink = undefined
    session.lastLinkBuffer = undefined
    session.lastDownloadBuffer = undefined
    session.lastPackBuffer = undefined
    session.isAborting = false

    await this.sessionStore.update(session.hash, {
      downloadCompleted: false,
      downloadLink: undefined,
      lastLinkStatus: undefined,
      lastDownloadStatus: undefined,
      lastPackStatus: undefined,
      isAborting: false
    })

    return false
  }

  /**
   * Handle WebSocket connections for downloading galleries
   * @param c Context containing request and response information
   * @returns WebSocket events
   */
  public handle(c: Context<BlankEnv, '/ws/g/:id', BlankInput>): WSEvents<ServerWebSocket> {
    const id = c.req.param('id')
    const hash = new Bun.CryptoHasher('md5').update(id).digest('hex')
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
        const session = await this.getSession(id, hash)

        await this.ensureZipExists(session)
        await this.sessionStore.touch(hash)
        session.clients.add(socket)
        session.lastAccessTime = Date.now()
        Log.info(`WS Client Join: ${id} - ${ip} (${session.clients.size})`)

        if (session.downloadCompleted && !session.downloadPromise && !this.hasDownloadArtifact(session)) {
          Log.warn(`WS Replay Invalidated: ${id} - missing artifact, restarting flow`)
          this.resetSessionForRedownload(session)
        }

        await this.sendSnapshotToClient(session, socket)

        if (!session.downloadCompleted && !session.downloadPromise) {
          const lockAcquired = await this.sessionStore.tryAcquireLock(hash, this.processID)

          if (lockAcquired) {
            Log.info(`WS Flow Start: ${id} - ${ip} (lock acquired by ${this.processID})`)
            session.downloadPromise = this.startDownloadFlow(id, session, ip).finally(async () => {
              session.downloadPromise = undefined
              if (session.downloadCompleted) {
                await this.sessionStore.update(session.hash, { downloadCompleted: true })
                Log.info(`WS Lock Release: ${id} - downloadCompleted saved to store`)
              }
              await this.sessionStore.releaseLock(hash, this.processID)
              Log.info(`WS Lock Released: ${id} - by ${this.processID}`)
            })
          } else {
            Log.info(`WS Flow Waiting: ${id} - ${ip} (another instance is downloading)`)
          }
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
  private async getSession(id: string | number, hash: string): Promise<DownloadSession> {
    let session = this.sessions.get(hash)

    if (session) {
      Log.info(`WS Session Reuse (local): ${id}`)
      await this.sessionStore.touch(hash)
      return session
    }

    // Check if session exists in shared store
    const sharedSession = await this.sessionStore.getOrCreate(id.toString(), hash)

    Log.info(`WS Session ${sharedSession.createdAt === sharedSession.lastActivityAt ? 'Create' : 'Resume'}: ${id} - ${hash}`)

    if (sharedSession.downloadCompleted) {
      Log.info(`WS Session already completed (downloadCompleted: true, hasLink: ${!!sharedSession.downloadLink})`)
    } else if (sharedSession.isDownloading) {
      Log.info(`WS Session currently downloading by ${sharedSession.downloadingBy}`)
    }

    // Reconstruct buffers from shared state if available
    const lastDownloadBuffer = sharedSession.lastDownloadStatus
      ? Buffer.from(sharedSession.lastDownloadStatus, 'base64')
      : undefined
    const lastPackBuffer = sharedSession.lastPackStatus
      ? Buffer.from(sharedSession.lastPackStatus, 'base64')
      : undefined
    const lastLinkBuffer = sharedSession.lastLinkStatus
      ? Buffer.from(sharedSession.lastLinkStatus, 'base64')
      : undefined

    session = {
      id: id.toString(),
      hash,
      clients: new Set(),
      downloadCompleted: sharedSession.downloadCompleted,
      filename: sharedSession.filename,
      lastDownloadBuffer,
      lastPackBuffer,
      lastLinkBuffer,
      downloadLink: sharedSession.downloadLink,
      isAborting: sharedSession.isAborting,
      lastAccessTime: Date.now(),
      lastDownloadPersistAt: 0
    }

    this.sessions.set(hash, session)
    return session
  }

  private hasDownloadArtifact(session: DownloadSession): boolean {
    if (!session.filename) {
      return false
    }

    const zipPath = path.join(this.downloadDir, session.hash, session.filename)
    return fs.existsSync(zipPath)
  }

  private resetSessionForRedownload(session: DownloadSession): void {
    session.downloadCompleted = false
    session.isAborting = false
    session.downloadLink = undefined
    session.filename = undefined
    session.lastLinkBuffer = undefined
    session.lastDownloadBuffer = undefined
    session.lastPackBuffer = undefined
    session.lastDownloadPersistAt = 0
  }

  private persistDownloadStatus(session: DownloadSession): void {
    if (!session.lastDownloadBuffer) {
      return
    }

    session.lastDownloadPersistAt = Date.now()
    this.sessionStore.update(session.hash, {
      lastDownloadStatus: session.lastDownloadBuffer.toString('base64')
    }).catch((error) => Log.warn(`Failed to persist download status for ${session.hash}: ${error}`))
  }

  private async flushDownloadStatus(session: DownloadSession): Promise<void> {
    if (!session.lastDownloadBuffer) {
      return
    }

    session.lastDownloadPersistAt = Date.now()
    await this.sessionStore.update(session.hash, {
      lastDownloadStatus: session.lastDownloadBuffer.toString('base64')
    })
  }

  private async sendSnapshotToClient(session: DownloadSession, ws: ServerWebSocket): Promise<void> {
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
      await new Promise(resolve => setTimeout(resolve, 500))
      ws.close()
    }
  }

  private broadcastToSession(session: DownloadSession, buffer: Buffer, cache?: StatusCacheKey): void {
    if (cache === 'download') {
      session.lastDownloadBuffer = buffer
      const shouldPersist = Date.now() - session.lastDownloadPersistAt >= WebSocketHandler.DOWNLOAD_STATUS_PERSIST_INTERVAL_MS
      if (shouldPersist) {
        this.persistDownloadStatus(session)
      }
    } else if (cache === 'pack') {
      this.flushDownloadStatus(session).catch((error) => Log.warn(`Failed to flush download status for ${session.hash}: ${error}`))
      session.lastPackBuffer = buffer
      this.sessionStore.update(session.hash, {
        lastPackStatus: buffer.toString('base64')
      }).catch((error) => Log.warn(`Failed to persist pack status for ${session.hash}: ${error}`))
    } else if (cache === 'link') {
      session.lastLinkBuffer = buffer
      this.sessionStore.update(session.hash, {
        lastLinkStatus: buffer.toString('base64')
      }).catch((error) => Log.warn(`Failed to persist link status for ${session.hash}: ${error}`))
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

  private async broadcastDownloadLink(session: DownloadSession, filename: string): Promise<void> {
    const link = `/download/${session.hash}/${encodeURIComponent(filename)}`
    session.downloadLink = link
    const buffer = Buffer.concat([Buffer.from([0x20]), Buffer.from(link)])

    await this.sessionStore.update(session.hash, {
      downloadLink: link,
      lastLinkStatus: buffer.toString('base64')
    })

    session.lastLinkBuffer = buffer

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

  private clearSessionBuffers(session: DownloadSession): void {
    session.lastDownloadBuffer = undefined
    session.lastPackBuffer = undefined
    session.lastLinkBuffer = undefined
    session.lastDownloadPersistAt = 0
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
      session.lastAccessTime = Date.now()
      Log.info(`WS Session Idle: ${id} - ${ip}`)
    }
  }

  private async startDownloadFlow(id: string, session: DownloadSession, ip: string): Promise<void> {
    const hash = session.hash

    if (session.lockRefreshTimer) {
      clearInterval(session.lockRefreshTimer)
      session.lockRefreshTimer = undefined
    }

    session.lockRefreshTimer = setInterval(async () => {
      try {
        const refreshed = await this.sessionStore.refreshLock(hash, this.processID)
        if (!refreshed) {
          Log.warn(`WS Lock Refresh Failed: ${id} - ${hash}`)
        }
      } catch (error) {
        Log.warn(`WS Lock Refresh Error: ${id} - ${hash} - ${error}`)
      }
    }, 60000)

    try {
      Log.info(`Fetching gallery metadata: ${id}`)
      const response = await this.nh.get(id)

      if (response.error) {
        session.isAborting = true
        Log.warn(`Gallery not found: ${id}`)
        const errorBuffer = Buffer.from([0x01])
        this.broadcastToSession(session, errorBuffer)
        await new Promise(resolve => setTimeout(resolve, 100))
        this.closeSessionClients(session, 1008, 'Resource Not Found')
        this.clearSessionBuffers(session)
        this.sessions.delete(hash)
        return
      }

      Log.info(`WS Download Start: ${response.id} - ${ip}`)
      const downloadDir = path.join(this.downloadDir, hash)
      fs.mkdirSync(downloadDir, { recursive: true })

      const images = response.pages.map(page => `${this.imageHost}/${page.path}`)

      const filename = this.generateFilename(response.id, response.title)
      session.filename = filename
      await this.sessionStore.update(session.hash, { filename })

      let retry = 0
      let success = false
      let lastResult: DownloadResult = { success: false, errorCode: 0x01 }

      while (!success && retry < 3 && !session.isAborting) {
        lastResult = await this.downloadManager.run({
          hash,
          images,
          filename,
          downloadDir,
          concurrentDownloads: this.concurrentImageDownloads,
          debug: process.env['NODE_ENV'] === 'development',
          onProgress: (completed, total) => {
            const buffer = Buffer.alloc(1 + 2 + 2)
            buffer[0] = 0x00
            buffer.writeUint16BE(completed, 1)
            buffer.writeUint16BE(total, 3)
            this.broadcastToSession(session, buffer, 'download')
          },
          onPackStart: () => {
            const packBuffer = Buffer.alloc(1)
            packBuffer[0] = 0x10
            this.broadcastToSession(session, packBuffer, 'pack')
          },
          isAborting: () => session.isAborting
        })
        success = lastResult.success
        if (!success) {
          retry++
        }
      }

      if (session.isAborting) {
        return
      }

      if (success) {
        await this.flushDownloadStatus(session)
        session.downloadCompleted = true
        await this.sessionStore.update(session.hash, { downloadCompleted: true })
        Log.info(`WS Download End: ${response.id} - ${ip}`)
        await this.broadcastDownloadLink(session, filename)
        this.closeSessionClients(session)
        this.downloadManager.cleanTempFiles(downloadDir, filename)
      } else {
        Log.error(`Failed to download gallery: ${response.id}`)
        const errorCode = !lastResult.success ? lastResult.errorCode : 0x01
        this.signalSessionFailure(session, Buffer.from([errorCode]), 1011, 'Download Failed')
      }
    } catch (error) {
      Log.error(`Error in WebSocket handler: ${error}`)
      this.signalSessionFailure(session, Buffer.from([0x01]), 1011, 'Internal Server Error')
    } finally {
      if (session.lockRefreshTimer) {
        clearInterval(session.lockRefreshTimer)
        session.lockRefreshTimer = undefined
      }
    }
  }

  private signalSessionFailure(session: DownloadSession, buffer: Buffer, closeCode: number, reason: string): void {
    if (session.isAborting) {
      return
    }

    session.isAborting = true
    this.flushDownloadStatus(session).catch((error) => Log.warn(`Failed to flush download status for ${session.hash}: ${error}`))
    this.sessionStore.update(session.hash, { isAborting: true }).catch((error) => {
      Log.warn(`Failed to persist abort status for ${session.hash}: ${error}`)
    })

    // Release lock on failure
    this.sessionStore.releaseLock(session.hash, this.processID).catch((error) => {
      Log.warn(`Failed to release lock during failure for ${session.hash}: ${error}`)
    })

    this.broadcastToSession(session, buffer)
    this.closeSessionClients(session, closeCode, reason)

    if (this.downloadManager.hasActiveDownload(session.hash)) {
      this.downloadManager
        .stopDownload(session.hash)
        .catch((error) => {
          Log.warn(`Failed to stop downloader during failure for ${session.hash}: ${error}`)
        })
        .finally(() => {
          if (session.lockRefreshTimer) {
            clearInterval(session.lockRefreshTimer)
            session.lockRefreshTimer = undefined
          }
          const downloadDir = path.join(this.downloadDir, session.hash)
          this.rmDir(downloadDir)
          this.sessions.delete(session.hash)
          this.sessionStore.delete(session.hash).catch((error) => {
            Log.warn(`Failed to delete session during failure cleanup for ${session.hash}: ${error}`)
          })
        })
      return
    }

    if (session.lockRefreshTimer) {
      clearInterval(session.lockRefreshTimer)
      session.lockRefreshTimer = undefined
    }

    this.clearSessionBuffers(session)
    session.downloadLink = undefined
    session.filename = undefined
    session.downloadPromise = undefined

    const downloadDir = path.join(this.downloadDir, session.hash)
    this.rmDir(downloadDir)
    this.sessions.delete(session.hash)
    this.sessionStore.delete(session.hash).catch((error) => {
      Log.warn(`Failed to delete session during failure cleanup for ${session.hash}: ${error}`)
    })
  }

  /**
   * Clean up orphaned download directories that no longer have active sessions
   */
  private async cleanOrphanedDownloads(): Promise<void> {
    try {
      if (!fs.existsSync(this.downloadDir)) {
        return
      }

      const allSessions = await this.sessionStore.getAll()
      const activeHashes = new Set(allSessions.map(s => s.hash))

      const directories = fs.readdirSync(this.downloadDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)

      for (const hash of directories) {
        if (activeHashes.has(hash)) {
          continue
        }

        const dirPath = path.join(this.downloadDir, hash)
        Log.info(`Cleaning orphaned download directory: ${hash}`)
        this.rmDir(dirPath)
      }

      for (const session of allSessions) {
        if (session.downloadCompleted && session.filename) {
          const gracePeriod = 30000 // 30 seconds
          const now = Date.now()

          if (now - session.lastActivityAt > gracePeriod) {
            const zipPath = path.join(this.downloadDir, session.hash, session.filename)
            if (!fs.existsSync(zipPath)) {
              Log.info(`Cleaning session with missing zip file: ${session.id} (${session.hash})`)
              const dirPath = path.join(this.downloadDir, session.hash)
              this.rmDir(dirPath)
              await this.sessionStore.delete(session.hash)
            }
          }
        }
      }
    } catch (error) {
      Log.error(`Error cleaning orphaned downloads: ${error}`)
    }
  }

  /**
   * Clean up stale in-memory sessions
   */
  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now()
    const sessionsToClean: string[] = []
    const IDLE_TIMEOUT = 3e5
    const FAILED_TIMEOUT = 6e4

    for (const [hash, session] of this.sessions.entries()) {
      const idleTime = now - session.lastAccessTime

      if (session.clients.size === 0 && (!session.downloadCompleted || session.isAborting) && idleTime > FAILED_TIMEOUT) {
        sessionsToClean.push(hash)
      } else if (session.clients.size === 0 && session.downloadCompleted && idleTime > IDLE_TIMEOUT) {
        sessionsToClean.push(hash)
      }
    }

    for (const hash of sessionsToClean) {
      const session = this.sessions.get(hash)
      if (!session) {
        continue
      }

      const storeSession = await this.sessionStore.get(hash)
      if (storeSession) {
        const storeIdleTime = now - storeSession.lastActivityAt
        const effectiveTimeout = storeSession.downloadCompleted && !storeSession.isAborting ? IDLE_TIMEOUT : FAILED_TIMEOUT
        if (storeIdleTime < effectiveTimeout) {
          session.lastAccessTime = storeSession.lastActivityAt
          continue
        }
      }

      Log.info(`Cleaning up stale session: ${session.id} (idle: ${Math.round((now - session.lastAccessTime) / 1000)}s)`)

      if (this.downloadManager.hasActiveDownload(session.hash) && !session.downloadCompleted) {
        session.isAborting = true
        await this.sessionStore.update(session.hash, { isAborting: true }).catch((error) => {
          Log.warn(`Failed to persist abort status during stale cleanup for ${session.hash}: ${error}`)
        })
        await this.downloadManager.stopDownload(session.hash).catch((error) => {
          Log.warn(`Failed to stop downloader during stale cleanup for ${session.hash}: ${error}`)
        })
      }

      if (session.lockRefreshTimer) {
        clearInterval(session.lockRefreshTimer)
        session.lockRefreshTimer = undefined
      }

      this.clearSessionBuffers(session)
      session.downloadLink = undefined
      session.filename = undefined
      session.downloadPromise = undefined
      session.clients.clear()

      const downloadDir = path.join(this.downloadDir, session.hash)
      this.rmDir(downloadDir)
      this.sessions.delete(hash)
      await this.sessionStore.releaseLock(session.hash, this.processID).catch((error) => {
        Log.warn(`Failed to release lock during stale cleanup for ${session.hash}: ${error}`)
      })
      await this.sessionStore.delete(session.hash).catch((error) => {
        Log.warn(`Failed to delete session during stale cleanup for ${session.hash}: ${error}`)
      })
    }
  }

  /**
   * Start periodic cleanup jobs
   */
  private startOrphanedDownloadsCleanup(): void {
    const clusterID = process.env['CLUSTER_ID']
    if (clusterID !== undefined && clusterID !== '0') {
      return
    }

    this.cleanupCron = new CronJob('*/5 * * * *', () => {
      this.cleanupStaleSessions().then(() => this.cleanOrphanedDownloads())
    })
    this.cleanupCron.start()

    this.initialCleanupTimer = setTimeout(() => {
      this.initialCleanupTimer = undefined
      this.cleanupStaleSessions().then(() => this.cleanOrphanedDownloads())
    }, 5000)
  }

  /**
   * Stop cleanup job
   */
  public async close(): Promise<void> {
    if (this.initialCleanupTimer) {
      clearTimeout(this.initialCleanupTimer)
      this.initialCleanupTimer = undefined
    }

    if (this.cleanupCron) {
      this.cleanupCron.stop()
      this.cleanupCron = undefined
    }

    this.downloadManager.stopAll()

    const lockReleases: Promise<void>[] = []

    for (const [hash, session] of this.sessions.entries()) {
      try {
        this.closeSessionClients(session, 1001, 'Server shutting down')

        if (session.lockRefreshTimer) {
          clearInterval(session.lockRefreshTimer)
          session.lockRefreshTimer = undefined
        }

        lockReleases.push(this.sessionStore.releaseLock(hash, this.processID))

        Log.info(`Cleaned up session: ${hash}`)
      } catch (error) {
        Log.warn(`Error cleaning up session ${hash}: ${error}`)
      }
    }
    this.sessions.clear()

    await Promise.allSettled(lockReleases)

    Log.info('WebSocket handler cleanup complete')
  }
}

/**
 * 0x00 Download progress
 * 0x01 Download error
 * 0x10 Pack progress
 * 0x11 Pack error
 * 0x20 Download link
 */
