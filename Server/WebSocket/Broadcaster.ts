import fs from 'fs'
import path from 'path'

import type { ServerWebSocket } from 'bun'

import Log from '../Tools/Log'
import { encodeLink, encodeWarning } from '../Protocol'

import type { DownloadSession, WSDeps } from './Session'

type StatusCacheKey = 'download' | 'pack' | 'link'
export type PrepareStatus = 'started' | 'ready' | 'error'

export const MISSING_PAGES_FILE = '.missing-pages.json'

const DOWNLOAD_STATUS_PERSIST_INTERVAL_MS = 1000

/** Sends frames to a session's clients and keeps the last of each kind for late joiners */
export default class Broadcaster {
  constructor(private deps: WSDeps) {}

  /** Kept next to the archives, so every instance and a restarted one can replay it */
  missingPagesWarning(hash: string): Buffer | undefined {
    try {
      const warning = fs.readFileSync(path.join(this.deps.downloadDir, hash, MISSING_PAGES_FILE))
      return encodeWarning(warning)
    } catch {
      return undefined
    }
  }

  private persistDownloadStatus(session: DownloadSession): void {
    if (!session.lastDownloadBuffer) return

    session.lastDownloadPersistAt = Date.now()
    this.deps.sessionStore.update(session.hash, { lastDownloadStatus: session.lastDownloadBuffer.toString('base64') }).catch((error) => Log.warn(`Failed to persist download status for ${session.hash}: ${error}`))
  }

  async flushDownloadStatus(session: DownloadSession): Promise<void> {
    if (!session.lastDownloadBuffer) return

    session.lastDownloadPersistAt = Date.now()
    await this.deps.sessionStore.update(session.hash, {
      lastDownloadStatus: session.lastDownloadBuffer.toString('base64')
    })
  }

  sendSnapshot(session: DownloadSession, ws: ServerWebSocket): void {
    if (ws.readyState !== 1) return

    if (session.lastDownloadBuffer) ws.send(session.lastDownloadBuffer)
    if (session.lastPackBuffer) ws.send(session.lastPackBuffer)

    if (session.lastLinkBuffer) {
      const warning = this.missingPagesWarning(session.hash)
      if (warning) ws.send(warning)
      ws.send(session.lastLinkBuffer)
    }
  }

  sendPrepareStatus(ws: ServerWebSocket, format: string, status: PrepareStatus, error?: string): void {
    if (ws.readyState !== 1) return

    try {
      ws.send(JSON.stringify({ type: 'prepare', format, status, ...(error ? { error } : {}) }))
    } catch (sendError) {
      Log.warn(`Failed to send prepare status for ${format}: ${sendError}`)
    }
  }

  /** Sends to every open client and forgets the closed ones */
  send(session: DownloadSession, buffer: Buffer): void {
    for (const client of Array.from(session.clients)) {
      if (client.readyState !== 1) {
        session.clients.delete(client)
        continue
      }
      try {
        client.send(buffer)
      } catch (error) {
        Log.warn(`Failed to send buffer to client in session ${session.hash}: ${error}`)
        session.clients.delete(client)
      }
    }
  }

  broadcast(session: DownloadSession, buffer: Buffer, cache?: StatusCacheKey): void {
    if (cache === 'download') {
      session.lastDownloadBuffer = buffer
      if (Date.now() - session.lastDownloadPersistAt >= DOWNLOAD_STATUS_PERSIST_INTERVAL_MS) {
        this.persistDownloadStatus(session)
      }
    } else if (cache === 'pack') {
      this.flushDownloadStatus(session).catch((error) => Log.warn(`Failed to flush download status for ${session.hash}: ${error}`))
      session.lastPackBuffer = buffer
      this.deps.sessionStore.update(session.hash, { lastPackStatus: buffer.toString('base64') }).catch((error) => Log.warn(`Failed to persist pack status for ${session.hash}: ${error}`))
    } else if (cache === 'link') {
      session.lastLinkBuffer = buffer
      this.deps.sessionStore.update(session.hash, { lastLinkStatus: buffer.toString('base64') }).catch((error) => Log.warn(`Failed to persist link status for ${session.hash}: ${error}`))
    }

    this.send(session, buffer)
  }

  async broadcastLink(session: DownloadSession, filename: string): Promise<void> {
    const link = `/download/${session.hash}/${encodeURIComponent(filename)}`
    session.downloadLink = link
    const buffer = encodeLink(link)

    await this.deps.sessionStore.update(session.hash, {
      downloadLink: link,
      lastLinkStatus: buffer.toString('base64')
    })

    session.lastLinkBuffer = buffer
    this.send(session, buffer)
  }

  closeClients(session: DownloadSession, code = 1000, reason?: string): void {
    for (const client of Array.from(session.clients)) {
      try {
        client.close(code, reason)
      } catch (error) {
        Log.warn(`Failed to close client in session ${session.hash}: ${error}`)
      }
    }
  }
}
