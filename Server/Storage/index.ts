import fs from 'fs'
import path from 'path'
import { Database } from 'bun:sqlite'
import { S3Client } from 'bun'

import Log from '../Tools/Log'

import Config from '../../Config'

export interface ArchiveHandle {
  size: number
  /** Bytes [start, end), or the whole archive */
  stream(start?: number, end?: number): ReadableStream<Uint8Array> | Blob
}

interface IndexRow {
  key: string
  size: number
}

const CONTENT_TYPES: Record<string, string> = {
  '.zip': 'application/zip',
  '.cbz': 'application/vnd.comicbook+zip',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip'
}

/**
 * Finished archives: local only, or uploaded to S3 as `<prefix>/<hash>/<file>`.
 * `archives.db` (shared by every instance) tracks size and last download for eviction.
 */
export default class ArchiveStore {
  readonly remote: boolean
  private client: S3Client | null = null
  private db: Database | null = null
  private downloadDir: string
  private uploads = new Map<string, Promise<void>>()

  constructor(downloadDir: string, cacheDir: string) {
    this.downloadDir = downloadDir
    const s3 = Config.s3
    this.remote = Boolean(s3.bucket)

    if (!this.remote) return

    this.client = new S3Client({
      bucket: s3.bucket,
      endpoint: s3.endpoint || undefined,
      region: s3.region,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      virtualHostedStyle: s3.virtualHostedStyle
    })

    fs.mkdirSync(cacheDir, { recursive: true })
    this.db = new Database(path.join(cacheDir, 'archives.db'), { create: true })
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=NORMAL')
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS archives (
      key TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      lastAccessAt INTEGER NOT NULL
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS archives_last_access ON archives (lastAccessAt)')
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }

  private key(hash: string, file: string): string {
    return Config.s3.prefix ? `${Config.s3.prefix}/${hash}/${file}` : `${hash}/${file}`
  }

  private localPath(hash: string, file: string): string {
    return path.join(this.downloadDir, hash, file)
  }

  private contentType(file: string): string {
    return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  }

  /** Whether the archive is on local disk or in the bucket */
  async has(hash: string, file: string): Promise<boolean> {
    if (fs.existsSync(this.localPath(hash, file))) return true
    if (!this.client || !this.db) return false

    const key = this.key(hash, file)
    try {
      if (await this.client.file(key).exists()) {
        if (!this.db.query('SELECT 1 FROM archives WHERE key = ?').get(key)) {
          const stat = await this.client.file(key).stat()
          this.record(key, stat.size, stat.lastModified.getTime())
        }
        return true
      }
    } catch (error) {
      Log.warn(`Archive lookup failed for ${key}: ${error}`)
      return false
    }

    this.db.query('DELETE FROM archives WHERE key = ?').run(key)
    return false
  }

  /** Concurrent calls for the same file share one upload */
  upload(hash: string, file: string): Promise<void> {
    if (!this.client) return Promise.resolve()

    const key = this.key(hash, file)
    const pending = this.uploads.get(key)
    if (pending) return pending

    const upload = (async () => {
      const source = Bun.file(this.localPath(hash, file))
      const started = Date.now()
      await this.client!.write(key, source, { type: this.contentType(file) })
      this.record(key, source.size, Date.now())
      Log.info(`Archive Uploaded: ${key} (${(source.size / 1048576).toFixed(1)} MB, ${Date.now() - started} ms)`)
    })().finally(() => this.uploads.delete(key))

    this.uploads.set(key, upload)
    return upload
  }

  /** A directory with a running upload must not be deleted yet */
  isUploading(hash: string): boolean {
    const prefix = this.key(hash, '')
    for (const key of this.uploads.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }


  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this.uploads.values()))
  }

  /** Prefers the local copy */
  async open(hash: string, file: string): Promise<ArchiveHandle | null> {
    const local = Bun.file(this.localPath(hash, file))
    if (await local.exists()) {
      this.touch(hash, file)
      return {
        size: local.size,
        stream: (start, end) => (start === undefined ? local : local.slice(start, end))
      }
    }

    if (!this.client || !this.db) return null

    const key = this.key(hash, file)
    const remote = this.client.file(key)
    try {
      const stat = await remote.stat()
      this.record(key, stat.size, Date.now())
      // A Response given an S3File redirects to a presigned URL, so stream instead
      return {
        size: stat.size,
        stream: (start, end) => (start === undefined ? remote.stream() : remote.slice(start, end).stream())
      }
    } catch (error) {
      Log.warn(`Archive open failed for ${key}: ${error}`)
      this.db.query('DELETE FROM archives WHERE key = ?').run(key)
      return null
    }
  }

  /** @returns whether the local file exists afterwards */
  async restore(hash: string, file: string): Promise<boolean> {
    const target = this.localPath(hash, file)
    if (fs.existsSync(target)) return true
    if (!this.client) return false

    const key = this.key(hash, file)
    const temp = `${target}.${process.pid}.restore`
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await Bun.write(temp, this.client.file(key))
      fs.renameSync(temp, target)
      Log.info(`Archive Restored: ${key}`)
      return true
    } catch (error) {
      fs.rmSync(temp, { force: true })
      Log.warn(`Archive restore failed for ${key}: ${error}`)
      return false
    }
  }


  touch(hash: string, file: string): void {
    if (!this.db) return
    this.db.query('UPDATE archives SET lastAccessAt = ? WHERE key = ?').run(Date.now(), this.key(hash, file))
  }

  private record(key: string, size: number, lastAccessAt: number): void {
    this.db!.query(
      `INSERT INTO archives (key, size, createdAt, lastAccessAt) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(key) DO UPDATE SET size = ?2, lastAccessAt = MAX(lastAccessAt, ?3)`
    ).run(key, size, lastAccessAt)
  }

  /** Rebuilds a new or lost index from the bucket listing */
  async reconcile(): Promise<void> {
    if (!this.client || !this.db) return
    if (this.db.query("SELECT 1 FROM meta WHERE name = 'reconciledAt'").get()) return

    const prefix = Config.s3.prefix ? `${Config.s3.prefix}/` : undefined
    let continuationToken: string | undefined
    let count = 0

    do {
      const page = await this.client.list({ prefix, maxKeys: 1000, continuationToken })
      const insert = this.db.transaction((items: NonNullable<typeof page.contents>) => {
        for (const item of items) {
          if (!item.key || !CONTENT_TYPES[path.extname(item.key).toLowerCase()]) continue
          const modified = item.lastModified ? new Date(item.lastModified).getTime() : Date.now()
          this.record(item.key, item.size ?? 0, modified)
          count++
        }
      })
      insert(page.contents ?? [])
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
    } while (continuationToken)

    this.db.query("INSERT OR REPLACE INTO meta (name, value) VALUES ('reconciledAt', ?)").run(String(Date.now()))
    Log.info(`Archive index reconciled from bucket: ${count} archive(s)`)
  }

  /** Expired archives first, then least recently downloaded until under the cap */
  async evict(): Promise<void> {
    if (!this.client || !this.db) return

    const victims: IndexRow[] = []

    if (Config.archiveRetentionDays > 0) {
      const cutoff = Date.now() - Config.archiveRetentionDays * 86400000
      victims.push(...(this.db.query('SELECT key, size FROM archives WHERE lastAccessAt < ?').all(cutoff) as IndexRow[]))
    }

    if (Config.archiveMaxGB > 0) {
      const maxBytes = Config.archiveMaxGB * 1024 ** 3
      const expired = new Set(victims.map((row) => row.key))
      let total = (this.db.query('SELECT COALESCE(SUM(size), 0) AS total FROM archives').get() as { total: number }).total
      total -= victims.reduce((sum, row) => sum + row.size, 0)

      if (total > maxBytes) {
        for (const row of this.db.query('SELECT key, size FROM archives ORDER BY lastAccessAt ASC').iterate() as IterableIterator<IndexRow>) {
          if (total <= maxBytes) break
          if (expired.has(row.key)) continue
          victims.push(row)
          total -= row.size
        }
      }
    }

    if (victims.length === 0) return

    let freed = 0
    for (const row of victims) {
      if (this.uploads.has(row.key)) continue
      try {
        await this.client.delete(row.key)
        this.db.query('DELETE FROM archives WHERE key = ?').run(row.key)
        freed += row.size
      } catch (error) {
        Log.warn(`Archive eviction failed for ${row.key}: ${error}`)
      }
    }

    Log.info(`Archive eviction: removed ${victims.length} archive(s), ${(freed / 1048576).toFixed(1)} MB`)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
