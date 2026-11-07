import './env'
import fs from 'fs'
import path from 'path'
import { describe, expect, test } from 'bun:test'

import Search from '../App/Pages/Search'
import { buildContentSecurityPolicy } from '../Server/Tools/SecurityHeaders'

const root = path.join(import.meta.dir, '..')

// The event catalog the analytics dashboard reads (nZip Analytics design, section 6)
const CATALOG: Record<string, string[]> = {
  download_start: ['gallery', 'format', 'source'],
  download_ready: ['gallery', 'format', 'pages', 'missing', 'seconds', 'source'],
  file_download: ['gallery', 'format', 'source', 'auto'],
  download_error: ['gallery', 'format', 'stage', 'source'],
  format_change: ['gallery', 'from', 'to'],
  search: ['sort', 'page', 'results', 'length'],
  search_rate_limited: ['seconds'],
  batch_download: ['count', 'format'],
  copy_link: ['gallery'],
  pref_change: ['key', 'value'],
  history_clear: [],
  shortcut: ['key'],
  ws_reconnect: ['attempt']
}

function clientSources(dir = path.join(root, 'Server', 'Scripts')): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return clientSources(full)
    return entry.name.endsWith('.ts') && entry.name !== 'Track.ts' ? [fs.readFileSync(full, 'utf8')] : []
  })
}

describe('event catalog', () => {
  const code = clientSources().join('\n')
  const calls = Array.from(code.matchAll(/\btrack\(\s*'([^']*)'/g), (match) => match[1])

  test('every catalog event is sent by the client code, spelled exactly', () => {
    for (const name of Object.keys(CATALOG)) expect(calls).toContain(name)
  })

  test('the client sends no event outside the catalog', () => {
    expect(calls.filter((name) => !(name in CATALOG))).toEqual([])
  })

  test('the typed catalog in Track.ts has exactly these data keys', () => {
    const source = fs.readFileSync(path.join(root, 'Server', 'Scripts', 'Shared', 'Track.ts'), 'utf8')
    const block = source.slice(source.indexOf('export interface TrackEvents'), source.indexOf('\n}', source.indexOf('export interface TrackEvents')))
    const typed: Record<string, string[]> = {}
    for (const match of block.matchAll(/^\s+(\w+): (?:\{([^}]*)\}|Record<string, never>)/gm)) {
      typed[match[1]!] = match[2] ? Array.from(match[2].matchAll(/(\w+):/g), (key) => key[1]!) : []
    }
    expect(typed).toEqual(CATALOG)
  })

  test('the search text never reaches an event', () => {
    for (const match of code.matchAll(/\btrack\('search',[^\n]*/g)) expect(match[0]).not.toMatch(/\bq\b|query|\.value/)
  })
})

describe('search page analytics attributes', () => {
  const render = (args: Partial<Parameters<typeof Search>[0]>) =>
    String(
      Search({
        query: 'artist:secret words',
        sort: 'popular-week',
        page: 3,
        numPages: 9,
        total: 1234,
        results: [{ id: 228922, title: 'T', thumbnail: 'x.jpg', width: 1, height: 1, pages: 24 }],
        api: 'https://api.example.test',
        t: (key) => key,
        tr: (_section, key) => key,
        script: (name) => `/Scripts/${name}.js`,
        ...args
      }).content
    )

  test('a results page carries counts only', () => {
    const html = render({})
    const grid = html.match(/<div class="search-grid"[^>]*>/)![0]
    expect(grid).toContain('data-sort="popular-week"')
    expect(grid).toContain('data-page="3"')
    expect(grid).toContain('data-total="1234"')
    expect(grid).toContain(`data-length="${'artist:secret words'.length}"`)
    expect(grid).not.toContain('data-retry-after')
    expect(grid).not.toContain('secret')
    expect(html).toContain('data-pages="24"')
  })

  test('a rate-limited search carries the wait and no search event data', () => {
    const grid = render({ error: 'Too many searches', retryAfter: 42, total: 0, results: [] }).match(/<div class="search-grid"[^>]*>/)![0]
    expect(grid).toContain('data-retry-after="42"')
    expect(grid).not.toContain('data-sort')
  })

  test('the empty search form sends nothing', () => {
    const grid = render({ query: '', total: 0, results: [] }).match(/<div class="search-grid"[^>]*>/)![0]
    expect(grid).not.toContain('data-sort')
  })
})

describe('recommended ANALYTICS snippet', () => {
  test('the derived policy allows the tracker script and its /api/send', () => {
    const analytics = '<script defer src="https://api.nhentai.zip/script.js" data-website-id="00000000-0000-0000-0000-000000000000" data-do-not-track="true"></script>'
    const policy = buildContentSecurityPolicy({ apiHost: 'https://api.nhentai.zip', imageHost: 'https://api.nhentai.zip', analytics, override: '' })!('nhentai.zip')
    const directive = (name: string) => policy.split('; ').find((part) => part.startsWith(`${name} `))!
    expect(directive('script-src').split(' ')).toContain('https://api.nhentai.zip')
    expect(directive('connect-src').split(' ')).toContain('https://api.nhentai.zip')
  })
})
