import fs from 'fs'
import path from 'path'

import Log from '../Tools/Log'
import { processID } from '../Runtime'
import type Lease from '../Storage/Lease'

import type FormatBuilder from './FormatBuilder'
import type SessionRegistry from './Session'
import type { WSDeps } from './Session'

const FAILED_SESSION_TIMEOUT_MS = 180000
const COMPLETED_SESSION_IDLE_TIMEOUT_MS = 300000
// Sessions finished this recently may not be indexed yet
const MISSING_ARCHIVE_GRACE_MS = 30000
// A directory written to this recently belongs to a download somewhere, even without a session
const ORPHAN_MIN_AGE_MS = 10 * 60000

// Lease lengths: longer than the interval of the job, so the holder renews before it expires
const SWEEP_LEASE_MS = 12 * 60000
const EVICT_LEASE_MS = 2 * 3600000
const RECONCILE_LEASE_MS = 30 * 60000

/**
 * Periodic cleanup. In-memory sessions are cleaned by every instance; the
 * shared disk, the session store and the bucket by the one holding the lease.
 */
export default class Janitor {
  private sweepCron?: Bun.CronJob
  private evictCron?: Bun.CronJob
  private initialTimer?: ReturnType<typeof setTimeout>

  constructor(
    private deps: WSDeps,
    private registry: SessionRegistry,
    private formats: FormatBuilder,
    private lease: Lease
  ) {}

  start(): void {
    this.sweepCron = Bun.cron('*/5 * * * *', () => this.sweep())
    this.initialTimer = setTimeout(() => {
      this.initialTimer = undefined
      void this.sweep()
    }, 5000)

    if (this.deps.archives.remote) {
      void this.reconcile()
      this.evictCron = Bun.cron('17 * * * *', () => this.evict())
    }
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.initialTimer = undefined
    this.sweepCron?.stop()
    this.sweepCron = undefined
    this.evictCron?.stop()
    this.evictCron = undefined
  }

  /** Never rejects: it runs from timers */
  async sweep(): Promise<void> {
    try {
      await this.cleanupStaleSessions()
    } catch (error) {
      Log.warn(`Stale session cleanup failed: ${error}`)
    }

    try {
      if (this.lease.acquire('sweep', SWEEP_LEASE_MS)) await this.cleanOrphanedDownloads()
    } catch (error) {
      Log.warn(`Orphaned download cleanup failed: ${error}`)
    }
  }

  async evict(): Promise<void> {
    try {
      if (this.lease.acquire('evict', EVICT_LEASE_MS)) await this.deps.archives.evict()
    } catch (error) {
      Log.warn(`Archive eviction failed: ${error}`)
    }
  }

  private async reconcile(): Promise<void> {
    try {
      if (this.lease.acquire('reconcile', RECONCILE_LEASE_MS)) await this.deps.archives.reconcile()
    } catch (error) {
      Log.warn(`Archive index reconcile failed: ${error}`)
    }
  }

  /** Download directories without a session anywhere, and sessions whose archive is gone */
  private async cleanOrphanedDownloads(): Promise<void> {
    const downloadDir = this.deps.downloadDir
    if (!fs.existsSync(downloadDir)) return

    const allSessions = await this.deps.sessionStore.getAll()
    const activeHashes = new Set(allSessions.map((session) => session.hash))
    const now = Date.now()

    const directories = fs
      .readdirSync(downloadDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)

    for (const hash of directories) {
      if (activeHashes.has(hash) || this.registry.get(hash) || this.formats.isPacking(hash) || this.deps.archives.isUploading(hash)) continue

      const dirPath = path.join(downloadDir, hash)
      try {
        if (now - fs.statSync(dirPath).mtimeMs < ORPHAN_MIN_AGE_MS) continue
      } catch {
        continue
      }

      Log.info(`Cleaning orphaned download directory: ${hash}`)
      this.registry.removeDir(hash)
    }

    for (const session of allSessions) {
      if (!session.downloadCompleted || !session.filename) continue
      if (now - session.lastActivityAt <= MISSING_ARCHIVE_GRACE_MS) continue
      if (this.registry.get(session.hash)?.clients.size) continue

      // An indexed archive is taken as present: one HEAD per finished session every 5 minutes adds up
      const state = await this.deps.archives.status(session.hash, session.filename, { trustIndex: true })
      if (state !== 'missing') continue

      Log.info(`Cleaning session with missing zip file: ${session.id} (${session.hash})`)
      this.registry.removeDir(session.hash)
      await this.deps.sessionStore.delete(session.hash)
    }
  }

  /** Sessions of this instance nobody has used for a while */
  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now()
    const stale: string[] = []

    for (const session of this.registry.values()) {
      this.registry.pruneClients(session)
      if (session.clients.size > 0) continue

      const idleTime = now - session.lastAccessTime
      const timeout = session.downloadCompleted && !session.isAborting ? COMPLETED_SESSION_IDLE_TIMEOUT_MS : FAILED_SESSION_TIMEOUT_MS
      if (idleTime > timeout) stale.push(session.hash)
    }

    for (const hash of stale) {
      const session = this.registry.get(hash)
      if (!session) continue

      const storeSession = await this.deps.sessionStore.get(hash)
      if (storeSession) {
        if (storeSession.isDownloading && storeSession.downloadingBy !== processID) {
          Log.info(`Skipping stale cleanup for remote active session: ${session.id} (${storeSession.downloadingBy ?? 'unknown'})`)
          this.registry.detach(session)
          continue
        }

        // Still in use through the other instance
        const storeIdleTime = now - storeSession.lastActivityAt
        const effectiveTimeout = storeSession.downloadCompleted && !storeSession.isAborting ? COMPLETED_SESSION_IDLE_TIMEOUT_MS : FAILED_SESSION_TIMEOUT_MS
        if (storeIdleTime < effectiveTimeout) {
          session.lastAccessTime = storeSession.lastActivityAt
          continue
        }
      }

      Log.info(`Cleaning up stale session: ${session.id} (idle: ${Math.round((now - session.lastAccessTime) / 1000)}s)`)

      if (this.deps.downloadManager.hasActiveDownload(hash) && !session.downloadCompleted) {
        session.isAborting = true
        await this.deps.sessionStore.update(hash, { isAborting: true }).catch((error) => {
          Log.warn(`Failed to persist abort status during stale cleanup for ${hash}: ${error}`)
        })
        await this.deps.downloadManager.stopDownload(hash).catch((error) => {
          Log.warn(`Failed to stop downloader during stale cleanup for ${hash}: ${error}`)
        })
      }

      this.registry.detach(session)
      this.registry.removeDir(hash)
      await this.deps.sessionStore.releaseLock(hash, processID).catch((error) => {
        Log.warn(`Failed to release lock during stale cleanup for ${hash}: ${error}`)
      })
      await this.deps.sessionStore.delete(hash).catch((error) => {
        Log.warn(`Failed to delete session during stale cleanup for ${hash}: ${error}`)
      })
    }
  }
}
