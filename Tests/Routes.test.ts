import './env'
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import type { AppEnv } from '../Server/Render'
import type ArchiveStore from '../Server/Storage'
import type { ArchiveHandle } from '../Server/Storage'
import type nh from '../Server/Tools/nh'
import type WebSocketHandler from '../Server/WebSocket'
import registerDownload, { activeDownloads } from '../Server/Routes/Download'
import registerPages from '../Server/Routes/Pages'
import registerWebSocket from '../Server/Routes/WS'

function app(): Hono<AppEnv> {
  const hono = new Hono<AppEnv>()
  hono.use(async (c, next) => {
    c.set('language', 'en_us')
    await next()
  })
  return hono
}

describe('/ws/g/:id', () => {
  const handled: string[] = []
  const hono = app()
  registerWebSocket(hono, { handler: { handle: (id: string) => (handled.push(id), {}) } as unknown as WebSocketHandler })

  test('an encoded path in the ID never reaches the handler', async () => {
    for (const path of ['/ws/g/..%2F..%2Fsearch', '/ws/g/1e3', '/ws/g/0x10', '/ws/g/Infinity', '/ws/g/0']) {
      expect((await hono.request(path)).status).toBe(400)
    }
    expect(handled).toEqual([])
  })
})

describe('/g/:id', () => {
  const asked: string[] = []
  const hono = app()
  const fake = {
    get: async (id: string) => {
      asked.push(id)
      return { id: Number(id), title: { english: 'T', japanese: '', pretty: '' }, pages: [{ path: 'p/1.jpg' }] }
    }
  } as unknown as nh
  registerPages(hono, { nh: fake, appDir: 'App' })

  test('IDs Number() would take are a 404 and never asked for', async () => {
    for (const path of ['/g/1e3', '/g/0x10', '/g/Infinity', '/g/..%2Fx']) {
      expect((await hono.request(path)).status).toBe(404)
    }
    expect(asked).toEqual([])
  })

  test('leading zeros redirect to the canonical ID, keeping the query', async () => {
    const response = await hono.request('/g/0228922?format=pdf')
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/g/228922?format=pdf')
  })

  test('a valid ID is looked up', async () => {
    expect((await hono.request('/g/228922')).status).toBe(200)
    expect(asked).toEqual(['228922'])
  })
})

describe('/download', () => {
  const hash = 'd41d8cd98f00b204e9800998ecf8427e'
  const content = new Blob(['0123456789'])
  const opened: Array<{ file: string; touch?: boolean }> = []
  const archive: ArchiveHandle = {
    size: 10,
    etag: '"a-1"',
    lastModified: new Date('2026-11-06T10:00:00Z'),
    stream: (start, end) => (start === undefined ? content : content.slice(start, end))
  }
  const bigContent = new Blob([new Uint8Array(8 * 1024 * 1024)])
  const big: ArchiveHandle = { ...archive, size: bigContent.size, stream: () => bigContent }
  const archives = {
    open: async (_hash: string, file: string, options: { touch?: boolean } = {}) => {
      opened.push({ file, touch: options.touch })
      if (file === '[2] big.zip') return big
      return file === '[1] 100% done.zip' ? archive : null
    }
  } as unknown as ArchiveStore

  const hono = app()
  registerDownload(hono, { archives, downloadDir: '/tmp/nzip-test-downloads' })

  test('a name with a literal % is decoded once', async () => {
    const response = await hono.request(`/download/${hash}/${encodeURIComponent('[1] 100% done.zip')}`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('0123456789')
    expect(response.headers.get('etag')).toBe('"a-1"')
    expect(response.headers.get('last-modified')).toBe('Fri, 06 Nov 2026 10:00:00 GMT')
  })

  test('a malformed escape is a 404, not a 500', async () => {
    expect((await hono.request(`/download/${hash}/%E0%A4%A.zip`)).status).toBe(404)
  })

  test('ranges, and If-Range for another version gets the whole file', async () => {
    const name = encodeURIComponent('[1] 100% done.zip')
    const partial = await hono.request(`/download/${hash}/${name}`, { headers: { Range: 'bytes=2-4', 'If-Range': '"a-1"' } })
    expect(partial.status).toBe(206)
    expect(await partial.text()).toBe('234')

    const stale = await hono.request(`/download/${hash}/${name}`, { headers: { Range: 'bytes=2-4', 'If-Range': '"old"' } })
    expect(stale.status).toBe(200)
    expect(await stale.text()).toBe('0123456789')
  })

  test('HEAD has no body and does not count as a download', async () => {
    opened.length = 0
    const response = await hono.request(`/download/${hash}/${encodeURIComponent('[1] 100% done.zip')}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('10')
    expect(await response.text()).toBe('')
    expect(opened).toEqual([{ file: '[1] 100% done.zip', touch: false }])
  })

  test('a stream counts as active until it ends or the client goes away', async () => {
    const name = encodeURIComponent('[1] 100% done.zip')
    expect(activeDownloads()).toBe(0)

    const response = await hono.request(`/download/${hash}/${name}`)
    expect(activeDownloads()).toBe(1)
    await response.text()
    expect(activeDownloads()).toBe(0)

    // Many chunks, so the first read does not reach the end
    const abandoned = await hono.request(`/download/${hash}/${encodeURIComponent('[2] big.zip')}`)
    const reader = abandoned.body!.getReader()
    await reader.read()
    expect(activeDownloads()).toBe(1)
    await reader.cancel()
    expect(activeDownloads()).toBe(0)
  })

  test('traversal and non-archive names', async () => {
    expect((await hono.request(`/download/${hash}/..%2F..%2Fsessions.db`)).status).toBe(404)
    expect((await hono.request(`/download/..%2F/x.zip`)).status).toBe(404)
  })
})
