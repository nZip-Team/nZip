import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { S3Client } from 'bun'

import Log from '../Tools/Log'
import { archiveEvicted, archiveEvictedBytes, timeS3 } from '../Tools/Metrics'

import Config from '../../Config'

export interface ArchiveHandle {
  size: number
  /** Changes whenever the archive is rebuilt */
  etag: string
  lastModified: Date
  /** Bytes [start, end), or the whole archive */
  stream(start?: number, end?: number): ReadableStream<Uint8Array> | Blob
}

interface IndexRow {
  key: string
  size: number
}

/** 'unknown': the bucket could not be asked, so nothing may be deleted or reset on that answer */
export type ArchiveState = 'exists' | 'missing' | 'unknown'

// Range requests come in bursts; the index only needs day precision
const TOUCH_INTERVAL_MS = 60000
// An archive handed out this recently is never evicted
const EVICTION_GUARD_MS = 10 * 60000

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
  private uploadSlots = Config.s3.uploadConcurrency
  private uploadQueue: (() => void)[] = []
  private touchedAt = new Map<string, number>()

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
      virtualHostedStyle: s3.virtualHostedStyle,
      partSize: s3.partSizeMB * 1048576
    })

    fs.mkdirSync(cacheDir, { recursive: true })
    this.db = new Database(path.join(cacheDir, 'archives.db'), { create: true })
    this.db.exec('PRAGMA busy_timeout=5000')
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA synchronous=NORMAL')
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

  /**
   * Whether the archive is on local disk or in the bucket
   * @param options.touch Count this as a download, so eviction keeps the archive
   * @param options.trustIndex Answer from archives.db when it lists the key, without asking the bucket
   */
  async status(hash: string, file: string, options: { touch?: boolean; trustIndex?: boolean } = {}): Promise<ArchiveState> {
    if (fs.existsSync(this.localPath(hash, file))) {
      if (options.touch) this.touch(hash, file)
      return 'exists'
    }
    if (!this.client || !this.db) return 'missing'

    const key = this.key(hash, file)
    const indexed = Boolean(this.db.query('SELECT 1 FROM archives WHERE key = ?').get(key))
    if (options.trustIndex && indexed) return 'exists'

    try {
      if (await timeS3('head', () => this.client!.file(key).exists())) {
        if (!indexed) {
          const stat = await timeS3('stat', () => this.client!.file(key).stat())
          this.record(key, stat.size, options.touch ? Date.now() : stat.lastModified.getTime())
        } else if (options.touch) {
          this.touch(hash, file)
        }
        return 'exists'
      }
    } catch (error) {
      Log.warn(`Archive lookup failed for ${key}: ${error}`)
      return 'unknown'
    }

    this.db.query('DELETE FROM archives WHERE key = ?').run(key)
    this.touchedAt.delete(key)
    return 'missing'
  }

  /** Only a confirmed copy counts; see status() */
  async has(hash: string, file: string, options: { touch?: boolean } = {}): Promise<boolean> {
    return (await this.status(hash, file, options)) === 'exists'
  }

  /** Concurrent calls for the same file share one upload */
  upload(hash: string, file: string): Promise<void> {
    if (!this.client || Config.s3.uploadsPaused) return Promise.resolve()

    const key = this.key(hash, file)
    const pending = this.uploads.get(key)
    if (pending) return pending

    const upload = this.withUploadSlot(async () => {
      const source = Bun.file(this.localPath(hash, file))
      const started = Date.now()
      await timeS3('put', () => this.client!.write(key, source, { type: this.contentType(file) }))
      this.record(key, source.size, Date.now())
      Log.info(`Archive Uploaded: ${key} (${(source.size / 1048576).toFixed(1)} MB, ${Date.now() - started} ms)`)
    }).finally(() => this.uploads.delete(key))

    this.uploads.set(key, upload)
    return upload
  }

  /** At most S3_UPLOAD_CONCURRENCY uploads run; the others wait in order (and still count as uploading) */
  private async withUploadSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.uploadSlots > 0) this.uploadSlots--
    else await new Promise<void>((resolve) => this.uploadQueue.push(resolve))

    try {
      return await run()
    } finally {
      const next = this.uploadQueue.shift()
      if (next) next()
      else this.uploadSlots++
    }
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

  /**
   * Prefers the local copy
   * @param options.touch Count this as a download (HEAD requests do not)
   * @returns null when the archive does not exist; throws when that cannot be told
   */
  async open(hash: string, file: string, options: { touch?: boolean } = {}): Promise<ArchiveHandle | null> {
    const local = Bun.file(this.localPath(hash, file))
    if (await local.exists()) {
      if (options.touch !== false) this.touch(hash, file)
      return {
        size: local.size,
        etag: `"${local.size.toString(36)}-${local.lastModified.toString(36)}"`,
        lastModified: new Date(local.lastModified),
        stream: (start, end) => (start === undefined ? local : local.slice(start, end))
      }
    }

    if (!this.client || !this.db) return null

    const key = this.key(hash, file)
    const remote = this.client.file(key)
    try {
      const stat = await timeS3('stat', () => remote.stat())
      if (options.touch !== false) {
        if (this.db.query('SELECT 1 FROM archives WHERE key = ?').get(key)) this.touch(hash, file)
        else this.record(key, stat.size, Date.now())
      }
      const etag = stat.etag ? `"${stat.etag.replace(/"/g, '')}"` : `"${stat.size.toString(36)}-${stat.lastModified.getTime().toString(36)}"`
      // A Response given an S3File redirects to a presigned URL, so stream instead
      return {
        size: stat.size,
        etag,
        lastModified: stat.lastModified,
        stream: (start, end) => (start === undefined ? remote.stream() : remote.slice(start, end).stream())
      }
    } catch (error) {
      // A failed stat says nothing on its own: only a confirmed miss drops the index row
      const state = await this.status(hash, file)
      if (state === 'missing') return null
      Log.warn(`Archive open failed for ${key}: ${error}`)
      throw error
    }
  }

  /** @returns whether the local file exists afterwards */
  async restore(hash: string, file: string): Promise<boolean> {
    const target = this.localPath(hash, file)
    if (fs.existsSync(target)) return true
    if (!this.client) return false

    const key = this.key(hash, file)
    // Every container runs as PID 1, so a PID would not tell two replicas apart
    // Hidden and short: long archive names leave no room for a suffix within the 255-byte limit
    const temp = path.join(path.dirname(target), `.restore-${randomUUID()}.tmp`)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      await timeS3('get', () => Bun.write(temp, this.client!.file(key)))
      // Another replica may have restored it meanwhile; the rename is atomic either way
      fs.renameSync(temp, target)
      Log.info(`Archive Restored: ${key}`)
      return true
    } catch (error) {
      fs.rmSync(temp, { force: true })
      if (fs.existsSync(target)) return true
      Log.warn(`Archive restore failed for ${key}: ${error}`)
      return false
    }
  }

  /** Throttled: one index write per archive and minute */
  touch(hash: string, file: string): void {
    if (!this.db) return
    const key = this.key(hash, file)
    const now = Date.now()
    if (now - (this.touchedAt.get(key) ?? 0) < TOUCH_INTERVAL_MS) return

    if (this.touchedAt.size > 10000) this.touchedAt.clear()
    this.touchedAt.set(key, now)
    this.db.query('UPDATE archives SET lastAccessAt = MAX(lastAccessAt, ?) WHERE key = ?').run(now, key)
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
      const page = await timeS3('list', () => this.client!.list({ prefix, maxKeys: 1000, continuationToken }))
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
    if (!this.client || !this.db || Config.s3.uploadsPaused) return

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

    let removed = 0
    let freed = 0
    const current = this.db.query('SELECT lastAccessAt FROM archives WHERE key = ?')
    for (const row of victims) {
      if (this.uploads.has(row.key)) continue
      // Downloaded or handed out since the victims were chosen
      const entry = current.get(row.key) as { lastAccessAt: number } | null
      if (!entry || entry.lastAccessAt > Date.now() - EVICTION_GUARD_MS) continue
      try {
        await timeS3('delete', () => this.client!.delete(row.key))
        this.db.query('DELETE FROM archives WHERE key = ?').run(row.key)
        this.touchedAt.delete(row.key)
        removed++
        freed += row.size
      } catch (error) {
        Log.warn(`Archive eviction failed for ${row.key}: ${error}`)
      }
    }

    archiveEvicted.inc({}, removed)
    archiveEvictedBytes.inc({}, freed)
    Log.info(`Archive eviction: removed ${removed} of ${victims.length} archive(s), ${(freed / 1048576).toFixed(1)} MB`)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
