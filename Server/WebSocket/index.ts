import type { ServerWebSocket } from 'bun'
import type { WSEvents } from 'hono/ws'

import Log from '../Tools/Log'
import { rateLimited } from '../Tools/Metrics'
import type nh from '../Tools/nh'
import type { IDownloadManager, ISessionStore } from '../Modules/Core'
import type ArchiveStore from '../Storage'
import type Lease from '../Storage/Lease'
import { processID } from '../Runtime'

import Broadcaster from './Broadcaster'
import { MessageLimiter, decodeMessage, parseClientCommand } from './Commands'
import DownloadFlow from './DownloadFlow'
import FormatBuilder from './FormatBuilder'
import Janitor from './Janitor'
import RemoteFollower from './RemoteFollower'
import SessionRegistry from './Session'
import type { DownloadSession, WSDeps } from './Session'

export default class WebSocketHandler {
  private deps: WSDeps
  private registry: SessionRegistry
  private broadcaster: Broadcaster
  private formats: FormatBuilder
  private follower: RemoteFollower
  private flow: DownloadFlow
  private janitor: Janitor

  constructor(nh: nh, downloadDir: string, sessionStore: ISessionStore, downloadManager: IDownloadManager, archives: ArchiveStore, lease: Lease) {
    this.deps = { nh, downloadDir, sessionStore, downloadManager, archives, state: { draining: false, closing: false } }
    this.registry = new SessionRegistry(this.deps)
    this.broadcaster = new Broadcaster(this.deps)
    this.formats = new FormatBuilder(this.deps, this.registry, this.broadcaster)
    this.follower = new RemoteFollower(this.deps, this.registry, this.broadcaster, (id, session, ip) => this.flow.maybeStart(id, session, ip))
    this.flow = new DownloadFlow(this.deps, this.registry, this.broadcaster, this.follower)
    this.janitor = new Janitor(this.deps, this.registry, this.formats, lease)

    this.registry.startKeepAlive()
    this.janitor.start()
  }

  /**
   * WebSocket events of one download page
   * @param id Validated, canonical gallery ID
   * @param ip Client tag for the log
   */
  public handle(id: string, ip: string): WSEvents<ServerWebSocket> {
    const hash = new Bun.CryptoHasher('md5').update(id).digest('hex')
    const limiter = new MessageLimiter()
    let socket: ServerWebSocket | null = null

    // Hono does not catch what these return: a rejection would take the process down
    return {
      onOpen: async (_evt, ws) => {
        try {
          socket = ws.raw ?? null
          if (!socket) {
            ws.close(1011, 'Internal Server Error')
            return
          }
          await this.join(id, hash, socket, ip)
        } catch (error) {
          Log.warn(`WS Open Failed: ${id} - ${ip} - ${error}`)
          try {
            ws.close(1011, 'Internal Server Error')
          } catch {
            // Already closed
          }
        }
      },

      onMessage: async (evt, ws) => {
        try {
          const raw = ws.raw
          if (!raw) {
            ws.close(1011, 'Internal Server Error')
            return
          }

          if (!limiter.allow()) {
            rateLimited.inc({ kind: 'ws_message' })
            Log.warn(`WS Message Limit: ${id} - ${ip}`)
            ws.close(1008, 'Too Many Messages')
            return
          }

          const session = this.registry.get(hash) ?? (await this.registry.getSession(id, hash))
          await this.handleClientMessage(session, raw, evt.data, id, ip)
        } catch (error) {
          Log.warn(`WS Message Failed: ${id} - ${ip} - ${error}`)
        }
      },

      onClose: () => {
        if (!socket) return
        const session = this.registry.get(hash)
        if (!session) return

        session.clients.delete(socket)
        if (session.clients.size === 0) {
          session.lastAccessTime = Date.now()
          Log.info(`WS Session Idle: ${id} - ${ip}`)
        }
      }
    }
  }

  private async join(id: string, hash: string, socket: ServerWebSocket, ip: string): Promise<void> {
    const session = await this.registry.getSession(id, hash)

    await this.registry.ensureZipExists(session)
    await this.registry.touch(session)

    // Closed while the session loaded: onClose has run already and would never remove it
    if (socket.readyState !== 1) return

    session.clients.add(socket)
    Log.info(`WS Client Join: ${id} - ${ip} (${session.clients.size})`)

    if (session.downloadCompleted && !session.downloadPromise && !session.filename) {
      Log.warn(`WS Replay Invalidated: ${id} - missing artifact, restarting flow`)
      this.registry.reset(session)
    }

    this.broadcaster.sendSnapshot(session, socket)
    if (session.downloadPromise) {
      Log.info(`WS Flow In Progress: ${id} - ${ip}`)
    } else if (session.downloadCompleted) {
      Log.info(`WS Flow Replay: ${id} - ${ip}`)
    }
  }

  private async handleClientMessage(session: DownloadSession, ws: ServerWebSocket, rawData: unknown, id: string, ip: string): Promise<void> {
    const command = parseClientCommand(decodeMessage(rawData))
    if (!command) {
      Log.warn(`WS Invalid Command: ${id} - ${ip}`)
      return
    }

    await this.registry.touch(session)

    if (command.type === 'start') {
      await this.flow.maybeStart(id, session, ip, ws)
      return
    }

    await this.formats.prepare(session, ws, command.format)
  }

  /** Waits for running work up to the timeout; close() hands over the rest */
  public async drain(timeoutMs: number): Promise<void> {
    this.deps.state.draining = true
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.flow.activeCount() === 0 && this.formats.size === 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    await Promise.race([this.deps.archives.flush(), new Promise((resolve) => setTimeout(resolve, Math.max(deadline - Date.now(), 0)))])
  }

  public isDraining(): boolean {
    return this.deps.state.draining
  }

  public stats(): { sessions: number; clients: number; downloads: number; packing: number } {
    return {
      sessions: this.registry.size,
      clients: this.registry.clientCount(),
      downloads: this.flow.activeCount(),
      packing: this.formats.size
    }
  }

  /** Stop the jobs and hand every session over to the other instance */
  public async close(): Promise<void> {
    this.janitor.stop()
    this.registry.stopKeepAlive()

    this.deps.state.closing = true
    for (const session of this.registry.values()) {
      if (session.downloadPromise) session.isAborting = true
    }

    this.deps.downloadManager.stopAll()

    const lockReleases: Promise<void>[] = []

    for (const session of Array.from(this.registry.values())) {
      try {
        // 1012: the browser reconnects to another instance
        this.broadcaster.closeClients(session, 1012, 'Service Restart')
        session.lockRefreshTimer?.stop()
        session.lockRefreshTimer = undefined
        this.follower.stop(session)

        lockReleases.push(this.deps.sessionStore.releaseLock(session.hash, processID))
        Log.info(`Cleaned up session: ${session.hash}`)
      } catch (error) {
        Log.warn(`Error cleaning up session ${session.hash}: ${error}`)
      }
    }
    this.registry.clear()

    await Promise.allSettled(lockReleases)

    Log.info('WebSocket handler cleanup complete')
  }
}
