import Log from '../Tools/Log'
import { processID } from '../Runtime'
import { startInterval } from '../Tools/Interval'
import { OP_DOWNLOAD_ERROR, encodeError } from '../Protocol'
import type { SharedSessionData } from '../Modules/Core'

import type Broadcaster from './Broadcaster'
import type SessionRegistry from './Session'
import type { DownloadSession, WSDeps } from './Session'

type StartFlow = (id: string, session: DownloadSession, ip: string) => Promise<void>

/** Relays another instance's download from the shared store, and takes it over if that instance stops */
export default class RemoteFollower {
  constructor(
    private deps: WSDeps,
    private registry: SessionRegistry,
    private broadcaster: Broadcaster,
    private startFlow: StartFlow
  ) {}

  follow(id: string, session: DownloadSession, ip: string): void {
    if (session.followTimer) return

    let polling = false
    session.followTimer = startInterval(async () => {
      if (polling) return
      polling = true

      try {
        if (session.clients.size === 0 || session.downloadPromise || this.deps.state.draining) {
          this.stop(session)
          return
        }

        const shared = await this.deps.sessionStore.get(session.hash)
        if (!shared || shared.isAborting) {
          this.stop(session)
          this.closeAfterRemoteFailure(session)
          return
        }

        this.relay(session, shared)

        if (shared.downloadCompleted) {
          session.downloadCompleted = true
          session.filename = shared.filename ?? session.filename
          session.downloadLink = shared.downloadLink ?? session.downloadLink
          this.stop(session)
          return
        }

        if (!shared.isDownloading) {
          Log.info(`WS Flow Takeover: ${id} - ${ip} (previous owner ${shared.downloadingBy ?? 'unknown'} stopped)`)
          this.stop(session)
          await this.startFlow(id, session, ip)
        } else if (await this.deps.sessionStore.tryAcquireLock(session.hash, processID)) {
          // Stale lock: the owner is gone
          Log.info(`WS Flow Takeover: ${id} - ${ip} (stale lock of ${shared.downloadingBy ?? 'unknown'})`)
          await this.deps.sessionStore.releaseLock(session.hash, processID)
          this.stop(session)
          await this.startFlow(id, session, ip)
        }
      } catch (error) {
        Log.warn(`WS Follow Error: ${id} - ${error}`)
      } finally {
        polling = false
      }
    }, 1000)
  }

  stop(session: DownloadSession): void {
    session.followTimer?.stop()
    session.followTimer = undefined
  }

  private relay(session: DownloadSession, shared: SharedSessionData): void {
    const relay = (encoded: string | null | undefined, current: Buffer | undefined): Buffer | undefined => {
      if (!encoded) return current
      const buffer = Buffer.from(encoded, 'base64')
      if (current && current.equals(buffer)) return current
      this.broadcaster.send(session, buffer)
      return buffer
    }

    session.lastDownloadBuffer = relay(shared.lastDownloadStatus, session.lastDownloadBuffer)
    session.lastPackBuffer = relay(shared.lastPackStatus, session.lastPackBuffer)
    session.lastLinkBuffer = relay(shared.lastLinkStatus, session.lastLinkBuffer)
  }

  private closeAfterRemoteFailure(session: DownloadSession): void {
    this.broadcaster.broadcast(session, encodeError(OP_DOWNLOAD_ERROR))
    this.broadcaster.closeClients(session, 1011, 'Download Failed')
    this.registry.detach(session)
  }
}
