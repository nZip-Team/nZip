import fs from 'fs'
import path from 'path'

import type { ServerWebSocket } from 'bun'

import Log from '../Tools/Log'

import type Broadcaster from './Broadcaster'
import { MISSING_PAGES_FILE } from './Broadcaster'
import type { ArchiveFormat } from './Commands'
import type SessionRegistry from './Session'
import type { DownloadSession, WSDeps } from './Session'

// Big galleries can take longer to pack than the session expiry, which would let cleanup delete the files mid-pack
const PACK_KEEPALIVE_MS = 30000

/** Builds the cbz, pdf and epub variants of a finished download on request */
export default class FormatBuilder {
  private generation = new Map<string, Promise<void>>()

  constructor(
    private deps: WSDeps,
    private registry: SessionRegistry,
    private broadcaster: Broadcaster
  ) {}

  get size(): number {
    return this.generation.size
  }

  isPacking(hash: string): boolean {
    for (const key of this.generation.keys()) {
      if (key.startsWith(`${hash}:`)) return true
    }
    return false
  }

  async prepare(session: DownloadSession, ws: ServerWebSocket, format: ArchiveFormat): Promise<void> {
    if (!session.downloadCompleted || !session.filename) {
      this.broadcaster.sendPrepareStatus(ws, format, 'error', 'Download is not ready yet')
      return
    }

    const targetFile = session.filename.replace(/\.zip$/i, `.${format}`)

    if (await this.deps.archives.has(session.hash, targetFile, { touch: true })) {
      this.broadcaster.sendPrepareStatus(ws, format, 'ready')
      return
    }

    const generationKey = `${session.hash}:${targetFile}`
    let pending = this.generation.get(generationKey)

    if (!pending) {
      pending = this.build(session.hash, session.filename, format, targetFile)
      this.generation.set(generationKey, pending)
      pending.finally(() => this.generation.delete(generationKey)).catch(() => {})
    }
    this.broadcaster.sendPrepareStatus(ws, format, 'started')

    const keepAlive = setInterval(() => {
      this.registry.touch(session, true).catch(() => {})
    }, PACK_KEEPALIVE_MS)

    try {
      await pending
      this.broadcaster.sendPrepareStatus(ws, format, 'ready')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Log.warn(`WS Prepare Failed: ${session.id} - ${format} - ${message}`)
      // The detail can hold cache paths, so the browser only learns that it failed
      this.broadcaster.sendPrepareStatus(ws, format, 'error')
    } finally {
      clearInterval(keepAlive)
    }
  }

  /** Packs another format; restores and unpacks the stored zip when the images are gone */
  private async build(hash: string, filename: string, format: ArchiveFormat, targetFile: string): Promise<void> {
    const dir = path.join(this.deps.downloadDir, hash)
    // Hidden names are the core's temp and lock files
    const hasImages = fs.existsSync(dir) && fs.readdirSync(dir).some((name) => !name.startsWith('.') && /\.(jpe?g|png|gif|webp)$/i.test(name))

    if (!hasImages) {
      if (!(await this.deps.archives.restore(hash, filename))) {
        throw new Error('Archive is no longer available, please reload the page')
      }
      await this.deps.downloadManager.extractArchive(dir, filename)
    }

    // The other replica may have built it from the same shared directory meanwhile
    if (!fs.existsSync(path.join(dir, targetFile))) {
      await this.deps.downloadManager.packFormat(dir, filename, hash, format, [])
    }

    if (!fs.existsSync(path.join(dir, MISSING_PAGES_FILE))) {
      this.deps.archives.upload(hash, targetFile).catch((error) => Log.warn(`Failed to upload ${targetFile}: ${error}`))
    }
  }
}
