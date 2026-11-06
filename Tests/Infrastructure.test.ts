import './env'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, test } from 'bun:test'

import Lease from '../Server/Storage/Lease'
import { Counter, Histogram } from '../Server/Tools/Metrics'
import { buildContentSecurityPolicy, originsIn } from '../Server/Tools/SecurityHeaders'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nzip-test-'))

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('Lease', () => {
  test('one holder at a time, taken over after expiry', () => {
    const a = new Lease(tempDir, 'replica-a')
    const b = new Lease(tempDir, 'replica-b')

    expect(a.acquire('sweep', 1000, 0)).toBe(true)
    expect(b.acquire('sweep', 1000, 500)).toBe(false)
    // Renewal by the holder
    expect(a.acquire('sweep', 1000, 900)).toBe(true)
    expect(b.acquire('sweep', 1000, 1800)).toBe(false)
    expect(b.acquire('sweep', 1000, 1900)).toBe(true)
    expect(a.acquire('sweep', 1000, 1950)).toBe(false)

    // Separate jobs, separate leases
    expect(a.acquire('evict', 1000, 1950)).toBe(true)

    a.close()
    b.close()
  })

  test('closing hands the lease over at once', () => {
    const a = new Lease(tempDir, 'replica-a')
    const b = new Lease(tempDir, 'replica-b')
    const now = Date.now()

    expect(a.acquire('handover', 60000, now)).toBe(true)
    expect(b.acquire('handover', 60000, now)).toBe(false)
    a.close()
    expect(b.acquire('handover', 60000, now)).toBe(true)
    b.close()
  })
})

describe('Metrics', () => {
  test('counters render per label set', () => {
    const counter = new Counter('test_total', 'Test')
    expect(counter.render()).toContain('test_total 0')
    counter.inc({ route: '/g/*', status: '200' })
    counter.inc({ status: '200', route: '/g/*' }, 2)
    counter.inc({ route: 'say "hi"' })
    const text = counter.render().join('\n')
    expect(text).toContain('test_total{route="/g/*",status="200"} 3')
    expect(text).toContain('test_total{route="say \\"hi\\""} 1')
  })

  test('histograms are cumulative', () => {
    const histogram = new Histogram('test_seconds', 'Test', [0.1, 1])
    histogram.observe({ op: 'head' }, 0.05)
    histogram.observe({ op: 'head' }, 0.5)
    histogram.observe({ op: 'head' }, 5)
    const text = histogram.render().join('\n')
    expect(text).toContain('test_seconds_bucket{op="head",le="0.1"} 1')
    expect(text).toContain('test_seconds_bucket{op="head",le="1"} 2')
    expect(text).toContain('test_seconds_bucket{op="head",le="+Inf"} 3')
    expect(text).toContain('test_seconds_count{op="head"} 3')
  })
})

describe('Content-Security-Policy', () => {
  const sources = {
    apiHost: 'https://api.example.test',
    imageHost: 'https://images.example.test/i',
    analytics: `<script defer src="https://stats.example.test/script.js" data-website-id="x"></script>`,
    override: ''
  }

  test('allows the API, the image host and the analytics origin', () => {
    const policy = buildContentSecurityPolicy(sources)!('nhentai.zip')
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://stats.example.test")
    expect(policy).toContain('img-src')
    expect(policy).toContain('https://images.example.test')
    expect(policy).toContain("connect-src 'self' https://api.example.test https://stats.example.test")
    expect(policy).toContain('wss://nhentai.zip')
    expect(policy).toContain("frame-ancestors 'self'")
  })

  test('a strange Host header is left out', () => {
    const policy = buildContentSecurityPolicy(sources)!('evil; script-src *')
    expect(policy).not.toContain('evil')
  })

  test('override and off', () => {
    expect(buildContentSecurityPolicy({ ...sources, override: 'off' })).toBeNull()
    expect(buildContentSecurityPolicy({ ...sources, override: "default-src 'none'" })!('x')).toBe("default-src 'none'")
  })

  test('origins of a snippet', () => {
    expect(originsIn(`<script src='https://a.test/x.js'></script><img src="http://b.test:8080/p.gif">`)).toEqual(['https://a.test', 'http://b.test:8080'])
    expect(originsIn('')).toEqual([])
  })
})
