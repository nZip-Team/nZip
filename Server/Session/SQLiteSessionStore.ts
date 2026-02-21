import { Database } from 'bun:sqlite'
import path from 'path'
import fs from 'fs'

import Log from '../Modules/Log'

import type { SessionStore, SharedSessionData } from '.'

/**
 * SQLite-based session store
 */
export default class SQLiteSessionStore implements SessionStore {
  private db: Database
  private cleanupInterval: Timer | null = null

  constructor() {
    const dbFile = path.join(process.cwd(), fs.existsSync(path.join(process.cwd(), 'Server')) ? 'Server' : '', 'Cache', 'sessions.db')

    if (fs.existsSync(dbFile)) {
      try {
        fs.chmodSync(dbFile, 0o644)
      } catch (error) {
        Log.warn(`Could not change permissions on ${dbFile}, removing: ${error}`)
        fs.unlinkSync(dbFile)
      }
    }

    this.db = new Database(dbFile, { create: true, readwrite: true })

    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = NORMAL')
    this.db.run('PRAGMA busy_timeout = 5000')

    this.initDatabase()
    this.startCleanupJob()
  }

  private initDatabase(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        downloadCompleted INTEGER NOT NULL DEFAULT 0,
        isDownloading INTEGER NOT NULL DEFAULT 0,
        downloadingBy TEXT,
        filename TEXT,
        downloadLink TEXT,
        lastDownloadStatus TEXT,
        lastPackStatus TEXT,
        lastLinkStatus TEXT,
        isAborting INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        lastActivityAt INTEGER NOT NULL
      )
    `)

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_lastActivityAt ON sessions(lastActivityAt)
    `)
  }

  /**
   * Get or create a session
   */
  async getOrCreate(id: string, hash: string): Promise<SharedSessionData> {
    const existing = this.get(hash)
    if (existing) {
      await this.touch(hash)
      return existing
    }

    const now = Date.now()
    const session: SharedSessionData = {
      id,
      hash,
      downloadCompleted: false,
      isDownloading: false,
      isAborting: false,
      createdAt: now,
      lastActivityAt: now
    }

    this.db.run(
      `INSERT INTO sessions (hash, id, downloadCompleted, isDownloading, isAborting, createdAt, lastActivityAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [hash, id, 0, 0, 0, now, now]
    )

    return session
  }

  /**
   * Get a session by hash
   */
  get(hash: string): SharedSessionData | null {
    const row = this.db.query(`SELECT * FROM sessions WHERE hash = ?`).get(hash) as any
    if (!row) return null

    return {
      id: row.id,
      hash: row.hash,
      downloadCompleted: Boolean(row.downloadCompleted),
      isDownloading: Boolean(row.isDownloading),
      downloadingBy: row.downloadingBy,
      filename: row.filename,
      downloadLink: row.downloadLink,
      lastDownloadStatus: row.lastDownloadStatus,
      lastPackStatus: row.lastPackStatus,
      lastLinkStatus: row.lastLinkStatus,
      isAborting: Boolean(row.isAborting),
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt
    }
  }

  /**
   * Update session data
   */
  async update(hash: string, data: Partial<SharedSessionData>): Promise<void> {
    const updates: string[] = []
    const values: any[] = []

    if (data.downloadCompleted !== undefined) {
      updates.push('downloadCompleted = ?')
      values.push(data.downloadCompleted ? 1 : 0)
    }
    if (data.isDownloading !== undefined) {
      updates.push('isDownloading = ?')
      values.push(data.isDownloading ? 1 : 0)
    }
    if (data.downloadingBy !== undefined) {
      updates.push('downloadingBy = ?')
      values.push(data.downloadingBy)
    }
    if (data.filename !== undefined) {
      updates.push('filename = ?')
      values.push(data.filename)
    }
    if (data.downloadLink !== undefined) {
      updates.push('downloadLink = ?')
      values.push(data.downloadLink)
    }
    if (data.lastDownloadStatus !== undefined) {
      updates.push('lastDownloadStatus = ?')
      values.push(data.lastDownloadStatus)
    }
    if (data.lastPackStatus !== undefined) {
      updates.push('lastPackStatus = ?')
      values.push(data.lastPackStatus)
    }
    if (data.lastLinkStatus !== undefined) {
      updates.push('lastLinkStatus = ?')
      values.push(data.lastLinkStatus)
    }
    if (data.isAborting !== undefined) {
      updates.push('isAborting = ?')
      values.push(data.isAborting ? 1 : 0)
    }

    if (updates.length === 0) return

    updates.push('lastActivityAt = ?')
    values.push(Date.now())
    values.push(hash)

    this.db.run(
      `UPDATE sessions SET ${updates.join(', ')} WHERE hash = ?`,
      values
    )
  }

  /**
   * Update last activity timestamp
   */
  async touch(hash: string): Promise<void> {
    this.db.run(
      `UPDATE sessions SET lastActivityAt = ? WHERE hash = ?`,
      [Date.now(), hash]
    )
  }

  /**
   * Delete a session
   */
  async delete(hash: string): Promise<void> {
    this.db.run(`DELETE FROM sessions WHERE hash = ?`, [hash])
  }

  /**
   * Check if a session exists and is active
   */
  async exists(hash: string): Promise<boolean> {
    const row = this.db.query(`SELECT 1 FROM sessions WHERE hash = ?`).get(hash)
    return row !== null
  }

  /**
   * Try to acquire a download lock for a session
   * @param hash Session hash
   * @param processID Unique identifier for this process
   * @returns true if lock was acquired, false if another process already has it
   */
  async tryAcquireLock(hash: string, processID: string): Promise<boolean> {
    try {
      const staleCutoff = Date.now() - 3e5
      const result = this.db.run(
        `UPDATE sessions
         SET isDownloading = 1, downloadingBy = ?, lastActivityAt = ?
         WHERE hash = ? AND downloadCompleted = 0 AND (isDownloading = 0 OR lastActivityAt < ?)`,
        [processID, Date.now(), hash, staleCutoff]
      )
      return result.changes > 0
    } catch (error) {
      Log.error(`Error acquiring lock for ${hash}: ${error}`)
      return false
    }
  }

  /**
   * Release a download lock for a session
   * @param hash Session hash
   * @param processID Unique identifier for this process
   */
  async releaseLock(hash: string, processID: string): Promise<void> {
    try {
      this.db.run(
        `UPDATE sessions
         SET isDownloading = 0, downloadingBy = NULL
         WHERE hash = ? AND downloadingBy = ?`,
        [hash, processID]
      )
    } catch (error) {
      Log.error(`Error releasing lock for ${hash}: ${error}`)
    }
  }

  /**
   * Refresh an active lock by updating lastActivityAt
   */
  async refreshLock(hash: string, processID: string): Promise<boolean> {
    try {
      const result = this.db.run(
        `UPDATE sessions
         SET lastActivityAt = ?
         WHERE hash = ? AND downloadingBy = ? AND isDownloading = 1`,
        [Date.now(), hash, processID]
      )
      return result.changes > 0
    } catch (error) {
      Log.warn(`Error refreshing lock for ${hash}: ${error}`)
      return false
    }
  }

  /**
   * Clean up old sessions (older than 5 minutes)
   */
  private cleanup(): void {
    const fiveMinutesAgo = Date.now() - 3e5
    const result = this.db.run(
      `DELETE FROM sessions WHERE lastActivityAt < ?`,
      [fiveMinutesAgo]
    )

    if (result.changes > 0) {
      Log.info(`SQLiteSessionStore: Cleaned up ${result.changes} expired session(s)`)
    }
  }

  /**
   * Start periodic cleanup job
   */
  private startCleanupJob(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 60000)
  }

  /**
   * Stop cleanup job and close database
   */
  close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    this.db.run(`UPDATE sessions SET isDownloading = 0, downloadingBy = NULL WHERE isDownloading = 1`)

    this.db.close()
    return Promise.resolve()
  }

  /**
   * Get all active sessions (for debugging)
   */
  getAll(): SharedSessionData[] {
    const rows = this.db.query(`SELECT * FROM sessions`).all() as any[]
    return rows.map(row => ({
      id: row.id,
      hash: row.hash,
      downloadCompleted: Boolean(row.downloadCompleted),
      isDownloading: Boolean(row.isDownloading),
      downloadingBy: row.downloadingBy,
      filename: row.filename,
      downloadLink: row.downloadLink,
      lastDownloadStatus: row.lastDownloadStatus,
      lastPackStatus: row.lastPackStatus,
      lastLinkStatus: row.lastLinkStatus,
      isAborting: Boolean(row.isAborting),
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt
    }))
  }
}
