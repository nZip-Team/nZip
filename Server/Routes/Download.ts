import path from 'path'
import type { Hono } from 'hono'

import { Page, type AppEnv } from '../Render'
import type ArchiveStore from '../Storage'
import type { ArchiveHandle } from '../Storage'
import Log from '../Tools/Log'
import { getArchiveContentType, sanitizePath } from '../Tools/Paths'
import { ifRangeMatches, parseRangeHeader } from '../Tools/Range'

let activeStreams = 0

/** Archive downloads still sending; shutdown waits for them */
export function activeDownloads(): number {
  return activeStreams
}

export async function waitForDownloads(deadline: number): Promise<void> {
  while (activeStreams > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Counts the stream as active until it ends, fails or the client goes away */
function track(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  activeStreams++
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    activeStreams--
  }

  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    }
  })
}

function body(archive: ArchiveHandle, start?: number, end?: number): ReadableStream<Uint8Array> {
  const source = archive.stream(start, end)
  return track(source instanceof Blob ? source.stream() : source)
}

export default function registerDownload(app: Hono<AppEnv>, deps: { archives: ArchiveStore; downloadDir: string }): void {
  // Hono answers HEAD with this GET handler too
  app.get('/download/:hash/:file', async (c) => {
    const head = c.req.method === 'HEAD'
    const hash = c.req.param('hash')
    // Already decoded by Hono; decoding again breaks names with a literal "%"
    const fileName = c.req.param('file')

    const dirPath = sanitizePath(hash, deps.downloadDir)
    const filePath = sanitizePath(fileName, path.join(deps.downloadDir, hash))
    const contentType = getArchiveContentType(fileName)
    const valid = dirPath && filePath && path.basename(filePath) === fileName && path.basename(dirPath) === hash && /^[0-9a-f]{32}$/.test(hash) && contentType

    let archive: ArchiveHandle | null = null
    if (valid) {
      try {
        // A HEAD is not a download, so it does not keep the archive from eviction
        archive = await deps.archives.open(hash, fileName, { touch: !head })
      } catch (error) {
        Log.warn(`Download failed for ${hash}/${fileName}: ${error}`)
        if (head) return new Response(null, { status: 503 })
        c.status(503)
        c.header('Retry-After', '30')
        return Page(c, 'Error', { error: 'Something went wrong while fetching the doujinshi, please try again later or go back to <a href="/">home</a>.' })
      }
    }

    if (!archive || !contentType) {
      if (head) return new Response(null, { status: 404 })
      const match = fileName.match(/^\[(\d+)\](.*?)\.(zip|cbz|pdf|epub)$/i)
      c.status(404)
      return Page(c, 'Error', {
        error: match ? 'The doujinshi with ID {id} is not available for download. You can go to <a href="/g/{id}">this page</a> and get a new link.' : 'That file does not exist. You can go back <a href="/">home</a> and get a new link.',
        id: match?.[1]
      })
    }

    const fileSize = archive.size
    // A resumed download of a rebuilt archive must start over, not mix two files
    const rangeHeader = ifRangeMatches(c.req.header('If-Range'), archive.etag, archive.lastModified) ? c.req.header('Range') : undefined
    const range = parseRangeHeader(rangeHeader, fileSize)

    const headers: Record<string, string> = {
      'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'content-type': contentType,
      'accept-ranges': 'bytes',
      etag: archive.etag,
      'last-modified': archive.lastModified.toUTCString()
    }

    if (range.unsatisfiable) {
      headers['content-range'] = `bytes */${fileSize}`
      return new Response(null, { status: 416, headers })
    }

    if (range.partial) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${fileSize}`
      headers['content-length'] = String(range.end - range.start + 1)
      return new Response(head ? null : body(archive, range.start, range.end + 1), { status: 206, headers })
    }

    headers['content-length'] = String(fileSize)
    return new Response(head ? null : body(archive), { headers })
  })
}
