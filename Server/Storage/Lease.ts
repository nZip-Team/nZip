import fs from 'fs'
import path from 'path'
import { Database } from 'bun:sqlite'

/**
 * Named leases in a SQLite file on the shared cache volume, so that one of the
 * replicas (or cluster workers) runs each periodic job.
 * The holder renews its lease on every run; when it stops renewing, the lease
 * expires and another process takes the job over.
 */
export default class Lease {
  private db: Database | null

  constructor(
    cacheDir: string,
    private holder: string
  ) {
    fs.mkdirSync(cacheDir, { recursive: true })
    this.db = new Database(path.join(cacheDir, 'leases.db'), { create: true })
    // busy_timeout first: two replicas may switch the new file to WAL at the same moment
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expiresAt INTEGER NOT NULL)')
  }

  /**
   * Take or renew a lease
   * @param name Job name
   * @param ttlMs How long the lease lasts without a renewal
   * @returns Whether this process holds the lease now
   */
  acquire(name: string, ttlMs: number, now: number = Date.now()): boolean {
    if (!this.db) return false
    // One statement, so two processes cannot both see the lease as free
    this.db
      .query(
        `INSERT INTO leases (name, holder, expiresAt) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expiresAt = excluded.expiresAt
         WHERE leases.holder = excluded.holder OR leases.expiresAt <= ?4`
      )
      .run(name, this.holder, now + ttlMs, now)
    const row = this.db.query('SELECT holder FROM leases WHERE name = ?').get(name) as { holder: string } | null
    return row?.holder === this.holder
  }

  /** Hand the jobs over at once instead of after the lease expires */
  releaseAll(): void {
    this.db?.query('DELETE FROM leases WHERE holder = ?').run(this.holder)
  }

  close(): void {
    try {
      this.releaseAll()
    } catch {
      // The other process takes over when the lease expires
    }
    this.db?.close()
    this.db = null
  }
}
