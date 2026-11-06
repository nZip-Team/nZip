import fs from 'fs'
import path from 'path'

import type { ServerWebSocket } from 'bun'

import Config from '../../Config'

import Log from '../Tools/Log'
import { startInterval } from '../Tools/Interval'
import { archiveLookups } from '../Tools/Metrics'
import { processID } from '../Runtime'
import type { DownloadResult } from '../Modules/Core'
import { OP_DOWNLOAD_ERROR, OP_PACK_ERROR, encodeError, encodePackStart, encodeProgress, warningPayload } from '../Protocol'

import type Broadcaster from './Broadcaster'
import { MISSING_PAGES_FILE } from './Broadcaster'
import { generateFilename } from './Filename'
import type RemoteFollower from './RemoteFollower'
import type SessionRegistry from './Session'
import type { DownloadSession, WSDeps } from './Session'

const LOCK_REFRESH_INTERVAL_MS = 30000

/** Downloads a gallery under the shared lock, or follows the instance that holds it */
export default class DownloadFlow {
  constructor(
    private deps: WSDeps,
    private registry: SessionRegistry,
    private broadcaster: Broadcaster,
    private follower: RemoteFollower
  ) {}

  activeCount(): number {
    let count = 0
    for (const session of this.registry.values()) if (session.downloadPromise) count++
    return count
  }

  /**
   * Start the download of a session, unless it runs or is done already
   * @param requester The socket that asked, when a client did
   */
  async maybeStart(id: string, session: DownloadSession, ip: string, requester?: ServerWebSocket): Promise<void> {
    if (session.downloadCompleted || session.downloadPromise) return

    if (this.deps.state.draining) {
      // Nothing here to join: the client reconnects to the instance that keeps serving
      if (requester && requester.readyState === 1) requester.close(1012, 'Service Restart')
      return
    }

    const lockAcquired = await this.deps.sessionStore.tryAcquireLock(session.hash, processID)

    // A second "start" may have started the flow while the lock was asked for
    if (session.downloadCompleted || session.downloadPromise) return

    if (!lockAcquired) {
      Log.info(`WS Flow Waiting: ${id} - ${ip} (another instance is downloading)`)
      this.follower.follow(id, session, ip)
      return
    }

    this.follower.stop(session)

    Log.info(`WS Flow Start: ${id} - ${ip} (lock acquired by ${processID})`)
    session.downloadPromise = this.run(id, session, ip)
      .catch((error) => Log.error(`WS Flow Error: ${id} - ${error}`))
      .then(() => this.finish(id, session))
      .catch((error) => Log.warn(`WS Flow Finish Error: ${id} - ${error}`))
  }

  private async finish(id: string, session: DownloadSession): Promise<void> {
    session.downloadPromise = undefined

    if (session.lockLost) {
      // The new owner serves the gallery; reconnecting clients follow it from a fresh session
      this.broadcaster.closeClients(session, 1012, 'Service Restart')
      this.registry.detach(session)
      return
    }

    if (session.downloadCompleted) {
      await this.deps.sessionStore.update(session.hash, { downloadCompleted: true })
      Log.info(`WS Lock Release: ${id} - downloadCompleted saved to store`)
    }
    await this.deps.sessionStore.releaseLock(session.hash, processID)
    Log.info(`WS Lock Released: ${id} - by ${processID}`)
  }

  private async run(id: string, session: DownloadSession, ip: string): Promise<void> {
    const hash = session.hash

    session.lockRefreshTimer?.stop()
    session.lockRefreshTimer = startInterval(async () => {
      try {
        const refreshed = await this.deps.sessionStore.refreshLock(hash, processID)
        if (!refreshed && !session.isAborting) {
          // Another instance owns the gallery now; two downloads into one directory would corrupt it
          Log.warn(`WS Lock Lost: ${id} - ${hash}, stopping the download`)
          session.lockLost = true
          session.isAborting = true
          session.lockRefreshTimer?.stop()
          session.lockRefreshTimer = undefined
        }
      } catch (error) {
        Log.warn(`WS Lock Refresh Error: ${id} - ${hash} - ${error}`)
      }
    }, LOCK_REFRESH_INTERVAL_MS)

    try {
      Log.info(`Fetching gallery metadata: ${id}`)
      const response = await this.deps.nh.get(id)

      if (response.error) {
        session.isAborting = true
        Log.warn(`Gallery not found: ${id}`)
        this.broadcaster.broadcast(session, encodeError(OP_DOWNLOAD_ERROR))
        await new Promise((resolve) => setTimeout(resolve, 100))
        this.broadcaster.closeClients(session, 1008, 'Resource Not Found')
        this.registry.detach(session)
        return
      }

      Log.info(`WS Download Start: ${response.id} - ${ip}`)
      const downloadDir = path.join(this.deps.downloadDir, hash)
      fs.mkdirSync(downloadDir, { recursive: true })

      const images = response.pages.map((page) => `${Config.imageHost}/${page.path}`)

      const filename = generateFilename(response.id, response.title)
      session.filename = filename
      await this.deps.sessionStore.update(session.hash, { filename })

      // Touched, so eviction keeps an archive whose link is handed out now
      if ((await this.deps.archives.status(hash, filename, { touch: true })) === 'exists') {
        archiveLookups.inc({ result: 'hit' })
        Log.info(`WS Archive Hit: ${response.id} - ${ip}`)
        this.broadcaster.broadcast(session, encodeProgress(images.length, images.length), 'download')
        this.broadcaster.broadcast(session, encodePackStart(), 'pack')
        await this.broadcaster.flushDownloadStatus(session)
        session.downloadCompleted = true
        await this.deps.sessionStore.update(session.hash, { downloadCompleted: true })
        await this.broadcaster.broadcastLink(session, filename)
        return
      }
      archiveLookups.inc({ result: 'miss' })

      let retry = 0
      let success = false
      let lastResult: DownloadResult = { success: false, errorCode: 0x01 }

      while (!success && retry < 3 && !session.isAborting) {
        lastResult = await this.deps.downloadManager.run({
          hash,
          images,
          filename,
          downloadDir,
          concurrentDownloads: Config.concurrentImageDownloads,
          debug: Config.development,
          onProgress: (completed, total) => this.broadcaster.broadcast(session, encodeProgress(completed, total), 'download'),
          onPackStart: () => this.broadcaster.broadcast(session, encodePackStart(), 'pack'),
          isAborting: () => session.isAborting
        })
        success = lastResult.success
        if (!success) {
          if (!lastResult.success && lastResult.errorCode === 0x03) break
          retry++
        }
      }

      if (session.isAborting) return

      if (success) {
        await this.broadcaster.flushDownloadStatus(session)
        session.downloadCompleted = true
        await this.deps.sessionStore.update(session.hash, { downloadCompleted: true })
        Log.info(`WS Download End: ${response.id} - ${ip}`)

        const missingPages = lastResult.success ? (lastResult.missingPages ?? []) : []
        const missing = missingPages.length
        if (missing > 0) {
          Log.warn(`WS Download Incomplete: ${response.id} - ${missing} of ${images.length} pages unavailable`)
          fs.writeFileSync(path.join(downloadDir, MISSING_PAGES_FILE), warningPayload(missingPages, images.length))
          const warning = this.broadcaster.missingPagesWarning(hash)
          if (warning) this.broadcaster.broadcast(session, warning)
        }

        await this.broadcaster.broadcastLink(session, filename)
        this.deps.downloadManager.cleanTempFiles(downloadDir, filename)
        // Missing pages may be recovered later, so incomplete archives stay out of the bucket
        if (missing === 0) {
          this.deps.archives.upload(hash, filename).catch((error) => Log.warn(`Failed to upload archive for ${response.id}: ${error}`))
        }
      } else {
        Log.error(`Failed to download gallery: ${response.id}`)
        const errorCode = !lastResult.success ? lastResult.errorCode : OP_DOWNLOAD_ERROR
        const buffer = errorCode === 0x03 ? encodeError(OP_DOWNLOAD_ERROR, 'None of the pages of this doujinshi are available anymore.') : encodeError(errorCode === OP_PACK_ERROR ? OP_PACK_ERROR : OP_DOWNLOAD_ERROR)
        this.signalFailure(session, buffer, 1011, 'Download Failed')
      }
    } catch (error) {
      if (this.deps.state.closing) {
        Log.info(`WS Flow Handed Over: ${id} - stopped by shutdown`)
        return
      }
      Log.error(`Error in WebSocket handler: ${error}`)
      this.signalFailure(session, encodeError(OP_DOWNLOAD_ERROR), 1011, 'Internal Server Error')
    } finally {
      session.lockRefreshTimer?.stop()
      session.lockRefreshTimer = undefined
    }
  }

  signalFailure(session: DownloadSession, buffer: Buffer, closeCode: number, reason: string): void {
    // Cut off by shutdown, not failed: another instance resumes from the same files
    if (session.isAborting || this.deps.state.closing) return

    session.isAborting = true
    this.broadcaster.flushDownloadStatus(session).catch((error) => Log.warn(`Failed to flush download status for ${session.hash}: ${error}`))
    this.deps.sessionStore.update(session.hash, { isAborting: true }).catch((error) => {
      Log.warn(`Failed to persist abort status for ${session.hash}: ${error}`)
    })
    this.deps.sessionStore.releaseLock(session.hash, processID).catch((error) => {
      Log.warn(`Failed to release lock during failure for ${session.hash}: ${error}`)
    })

    this.broadcaster.broadcast(session, buffer)
    this.broadcaster.closeClients(session, closeCode, reason)

    const cleanUp = () => {
      this.registry.detach(session)
      this.registry.removeDir(session.hash)
      this.deps.sessionStore.delete(session.hash).catch((error) => {
        Log.warn(`Failed to delete session during failure cleanup for ${session.hash}: ${error}`)
      })
    }

    if (this.deps.downloadManager.hasActiveDownload(session.hash)) {
      this.deps.downloadManager
        .stopDownload(session.hash)
        .catch((error) => Log.warn(`Failed to stop downloader during failure for ${session.hash}: ${error}`))
        .then(cleanUp)
        .catch((error) => Log.warn(`Failure cleanup failed for ${session.hash}: ${error}`))
      return
    }

    cleanUp()
  }
}
