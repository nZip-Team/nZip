import './env'
import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A stand-in S3 that records requests; set before Config is read
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
process.env['S3_ENDPOINT'] = `http://localhost:${server.port}`
process.env['S3_BUCKET'] = 'archives'
process.env['S3_ACCESS_KEY_ID'] = 'a'
process.env['S3_SECRET_ACCESS_KEY'] = 's'
process.env['S3_UPLOAD_CONCURRENCY'] = '2'

const { default: ArchiveStore } = await import('../Server/Storage')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nzip-upload-'))
afterAll(() => {
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
})
