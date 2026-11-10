import './env'
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A stand-in S3 that records requests
const requests: string[] = []
let inFlight = 0
let peak = 0
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    inFlight++
    peak = Math.max(peak, inFlight)
    await req.arrayBuffer()
    await Bun.sleep(30)
    inFlight--
    requests.push(`${req.method}${url.search ? ' ' + url.search.split('&')[0] : ''}`)
    if (req.method === 'POST' && url.search.startsWith('?uploads')) {
      return new Response('<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>')
    }
    if (req.method === 'POST') return new Response('<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>')
    return new Response('', { headers: { ETag: '"e"' } })
  }
})

// Config is read once per process, whichever test file imports it first: set the S3 part of it directly and put it back
const { default: Config } = await import('../Config')
const saved = { ...Config.s3 }
Object.assign(Config.s3, {
  endpoint: `http://localhost:${server.port}`,
  bucket: 'archives',
  region: 'garage',
  accessKeyId: 'a',
  secretAccessKey: 's',
  prefix: '',
  uploadConcurrency: 2,
  partSizeMB: 64
})

const { default: ArchiveStore } = await import('../Server/Storage')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nzip-upload-'))
afterAll(() => {
  Object.assign(Config.s3, saved)
  server.stop(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('archive uploads', () => {
  test('an archive over the old 5 MB part size is one PUT, and at most S3_UPLOAD_CONCURRENCY run at once', async () => {
    const store = new ArchiveStore(path.join(dir, 'downloads'), path.join(dir, 'cache'))
    for (const hash of ['a', 'b', 'c', 'd']) {
      fs.mkdirSync(path.join(dir, 'downloads', hash), { recursive: true })
      fs.writeFileSync(path.join(dir, 'downloads', hash, 'g.zip'), new Uint8Array(12 * 1024 * 1024))
    }

    const all = ['a', 'b', 'c', 'd'].map((hash) => store.upload(hash, 'g.zip'))
    expect(store.isUploading('d')).toBe(true) // queued, not yet running
    await Promise.all(all)

    expect(requests).toEqual(['PUT', 'PUT', 'PUT', 'PUT'])
    expect(peak).toBeLessThanOrEqual(2)
    expect(store.isUploading('d')).toBe(false)
  })

  test('S3_UPLOADS_PAUSED uploads nothing and evicts nothing', async () => {
    const store = new ArchiveStore(path.join(dir, 'downloads2'), path.join(dir, 'cache2'))
    fs.mkdirSync(path.join(dir, 'downloads2', 'p'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'downloads2', 'p', 'g.zip'), new Uint8Array(1024))
    requests.length = 0
    Config.s3.uploadsPaused = true
    try {
      await store.upload('p', 'g.zip')
      await store.evict()
    } finally {
      Config.s3.uploadsPaused = false
    }
    expect(requests).toEqual([])
    expect(store.isUploading('p')).toBe(false)
  })
})
