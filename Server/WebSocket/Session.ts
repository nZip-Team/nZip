import fs from 'fs'
import path from 'path'

import type { ServerWebSocket } from 'bun'

import Log from '../Tools/Log'
import { startInterval, type IntervalHandle } from '../Tools/Interval'
import type { IDownloadManager, ISessionStore } from '../Modules/Core'
import type ArchiveStore from '../Storage'
import type { ArchiveState } from '../Storage'
import type nh from '../Tools/nh'

export interface DownloadSession {
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
  /** Another instance took the download lock over while this one was downloading */
  lockLost?: boolean
  lastAccessTime: number
  lastTouchAt: number
  downloadPromise?: Promise<void>
  lockRefreshTimer?: IntervalHandle
  followTimer?: IntervalHandle
  lastDownloadPersistAt: number
}

/** Shared by the parts of the WebSocket handler */
export interface WSDeps {
  nh: nh
  downloadDir: string
  sessionStore: ISessionStore
  downloadManager: IDownloadManager
  archives: ArchiveStore
  state: { draining: boolean; closing: boolean }
}

// The core deletes sessions idle for 5 minutes; a page left open must keep its files
const KEEPALIVE_INTERVAL_MS = 60000
const TOUCH_INTERVAL_MS = 10000

export default class SessionRegistry {
  private sessions = new Map<string, DownloadSession>()
  private loads = new Map<string, Promise<DownloadSession>>()
  private keepAlive?: IntervalHandle

  constructor(private deps: WSDeps) {}

  get(hash: string): DownloadSession | undefined {
    return this.sessions.get(hash)
  }

  values(): IterableIterator<DownloadSession> {
    return this.sessions.values()
  }

  get size(): number {
    return this.sessions.size
  }

  clientCount(): number {
    let count = 0
    for (const session of this.sessions.values()) count += session.clients.size
    return count
  }

  async getSession(id: string, hash: string): Promise<DownloadSession> {
    const session = this.sessions.get(hash)
    if (session) return session

    // onOpen and onMessage both get here before the session is stored; they must share one object
    let loading = this.loads.get(hash)
    if (!loading) {
      loading = this.load(id, hash).finally(() => this.loads.delete(hash))
      this.loads.set(hash, loading)
    }
    return loading
  }

  private async load(id: string, hash: string): Promise<DownloadSession> {
    const shared = await this.deps.sessionStore.getOrCreate(id, hash)

    Log.info(`WS Session ${shared.createdAt === shared.lastActivityAt ? 'Create' : 'Resume'}: ${id} - ${hash}`)

    if (shared.downloadCompleted) {
      Log.info(`WS Session already completed (downloadCompleted: true, hasLink: ${!!shared.downloadLink})`)
    } else if (shared.isDownloading) {
      Log.info(`WS Session currently downloading by ${shared.downloadingBy}`)
    }

    const decode = (status: string | null | undefined) => (status ? Buffer.from(status, 'base64') : undefined)

    const session: DownloadSession = {
      id,
      hash,
      clients: new Set(),
      downloadCompleted: shared.downloadCompleted,
      filename: shared.filename ?? undefined,
      lastDownloadBuffer: decode(shared.lastDownloadStatus),
      lastPackBuffer: decode(shared.lastPackStatus),
      lastLinkBuffer: decode(shared.lastLinkStatus),
      downloadLink: shared.downloadLink ?? undefined,
      isAborting: shared.isAborting,
      lastAccessTime: Date.now(),
      lastTouchAt: 0,
      lastDownloadPersistAt: 0
    }

    this.sessions.set(hash, session)
    return session
  }

  /** Keeps the shared session alive; at most every few seconds unless forced */
  async touch(session: DownloadSession, force = false): Promise<void> {
    const now = Date.now()
    session.lastAccessTime = now
    if (!force && now - session.lastTouchAt < TOUCH_INTERVAL_MS) return
    session.lastTouchAt = now
    await this.deps.sessionStore.touch(session.hash)
  }

  /** Back to "not downloaded", in memory only */
  reset(session: DownloadSession): void {
    session.downloadCompleted = false
    session.isAborting = false
    session.downloadLink = undefined
    session.filename = undefined
    this.clearBuffers(session)
  }

  clearBuffers(session: DownloadSession): void {
    session.lastDownloadBuffer = undefined
    session.lastPackBuffer = undefined
    session.lastLinkBuffer = undefined
    session.lastDownloadPersistAt = 0
  }

  /** The shared counterpart of reset() */
  async resetStored(hash: string): Promise<void> {
    await this.deps.sessionStore.update(hash, {
      downloadCompleted: false,
      filename: null,
      downloadLink: null,
      lastLinkStatus: null,
      lastDownloadStatus: null,
      lastPackStatus: null,
      isAborting: false
    })
  }

  /** Forget a session here; the next client loads it from the shared store again */
  detach(session: DownloadSession): void {
    session.lockRefreshTimer?.stop()
    session.lockRefreshTimer = undefined
    session.followTimer?.stop()
    session.followTimer = undefined

    this.clearBuffers(session)
    session.downloadLink = undefined
    session.filename = undefined
    session.downloadPromise = undefined
    session.clients.clear()

    // A newer session for the same gallery may have replaced this one
    if (this.sessions.get(session.hash) === session) this.sessions.delete(session.hash)
  }

  clear(): void {
    this.sessions.clear()
  }

  /** A completed session must still have its archive; resets it only when the archive is surely gone */
  async ensureZipExists(session: DownloadSession): Promise<ArchiveState> {
    if (!session.downloadCompleted || !session.filename) return 'exists'

    const state = await this.deps.archives.status(session.hash, session.filename)
    if (state !== 'missing') return state

    Log.warn(`WS Missing Zip Reset: ${session.id} - ${session.filename}`)
    this.reset(session)
    await this.resetStored(session.hash)
    return 'missing'
  }

  /** Remove a gallery's download directory, unless an upload still reads from it */
  removeDir(hash: string): void {
    const dirPath = path.join(this.deps.downloadDir, hash)
    if (this.deps.archives.isUploading(hash) || !fs.existsSync(dirPath)) return

    let attempts = 0
    const tryRemove = () => {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true })
      } catch (error) {
        attempts++
        if (attempts < 3) {
          setTimeout(tryRemove, 500)
          return
        }
        Log.error(`Failed to remove directory ${dirPath} after ${attempts} attempts: ${error}`)
        const session = this.sessions.get(hash)
        if (session) this.detach(session)
      }
    }

    tryRemove()
  }

  /** Touch every session somebody is looking at, and drop sockets that are gone */
  startKeepAlive(): void {
    this.keepAlive = startInterval(
      async () => {
        for (const session of Array.from(this.sessions.values())) {
          this.pruneClients(session)
          if (session.clients.size === 0) continue
          await this.touch(session, true).catch((error) => Log.warn(`WS Keepalive Failed: ${session.id} - ${error}`))
        }
      },
      KEEPALIVE_INTERVAL_MS,
      { unref: true }
    )
  }

  stopKeepAlive(): void {
    this.keepAlive?.stop()
    this.keepAlive = undefined
  }

  pruneClients(session: DownloadSession): void {
    for (const client of Array.from(session.clients)) {
      if (client.readyState !== 1) session.clients.delete(client)
    }
  }
}
