import Bun from 'bun'
import { Hono, type Context } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { getConnInfo } from 'hono/bun'
import { languageDetector } from 'hono/language'

import fs from 'fs'
import path from 'path'

import WebSocketHandler from './WebSocket'

import Config from '../Config'

import NH, { type SearchSort } from './Tools/nh'
import RateLimiter from './Tools/RateLimiter'
import Log, { clientTag } from './Tools/Log'
import { parseRangeHeader } from './Tools/Range'
import { isLoopbackAddress, isTrustedProxy, loadTrustedProxies, parseIPAddress } from './Tools/TrustedProxy'

import Pages, { type PageName } from './Modules/Pages'
import Languages from './Modules/Language'
import Scripts from './Modules/Scripts'
import { Core } from './Modules/Core'
import LiveReload from './Modules/LiveReload'
import ArchiveStore from './Storage'

type AppEnv = { Variables: { language: string } }
type AppContext = Context<AppEnv>

let analytics: string | null = null

let filePath = './App'

const CacheStore = new Map<string, string>()
const CACHE_MAX_SIZE = 200

const trustedProxyRules = loadTrustedProxies(Config.trustedProxies, (entry, reason) => {
  Log.warn(`Ignoring invalid TRUSTED_PROXIES entry "${entry}": ${reason}`)
})

if (Config.trustXForwardedFor && trustedProxyRules.length === 0) {
  Log.warn('TRUST_X_FORWARDED_FOR is enabled, but TRUSTED_PROXIES is empty or invalid; X-Forwarded-For will be ignored')
}

// In development, flush all CacheStore entries for a page when it is reloaded
if (Config.development) {
  Pages.onReload((pageName) => {
    for (const key of Array.from(CacheStore.keys())) {
      if (key.startsWith(`${pageName}:`)) CacheStore.delete(key)
    }
    Log.info(`Cache cleared for page: ${pageName}`)
    LiveReload.broadcast('page')
  })
  Scripts.onReload(() => LiveReload.broadcast('script'))
  Languages.onReload(() => {
    CacheStore.clear()
    LiveReload.broadcast('language')
  })
  LiveReload.watchStyles(path.join(process.cwd(), filePath, 'Styles'))
}

const downloadDir = path.join(process.cwd(), fs.existsSync(path.join(process.cwd(), 'Server')) ? 'Server' : '', 'Cache', 'Downloads')
if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir, { recursive: true })
}

/**
 * Start the server
 */
export default async (): Promise<() => Promise<void>> => {
  const nh = new NH({
    endpoint: Config.apiHost
  })

  const core = new Core()
  await core.start()
  const sessionStore = core.sessionStore

  const archives = new ArchiveStore(downloadDir, path.dirname(downloadDir))
  let archiveCron: Bun.CronJob | undefined
  if (archives.remote) {
    Log.info(`Archives are stored in S3 bucket ${Config.s3.bucket} (retention ${Config.archiveRetentionDays || '∞'} days, cap ${Config.archiveMaxGB || '∞'} GB)`)
    archives.reconcile().catch((error) => Log.warn(`Archive index reconcile failed: ${error}`))

    archiveCron = Bun.cron('17 * * * *', async () => {
      await archives.evict().catch((error) => Log.warn(`Archive eviction failed: ${error}`))
    })
  }

  const WSHandler = new WebSocketHandler(
    nh,
    downloadDir,
    sessionStore,
    core.downloadManager,
    archives
  )

  const wsRateLimiter = new RateLimiter(Config.rateLimit, 60 * 1000)
  const searchRateLimiter = new RateLimiter(Config.rateLimit * 6, 60 * 1000)

  analytics = Config.analytics || null

  const supportedLanguages = Languages.getAvailableLanguages().map((l) => l.code)
  if (!supportedLanguages.includes('en_us')) supportedLanguages.push('en_us')

  const app = new Hono<AppEnv>()

  app.use(
    languageDetector({
      supportedLanguages,
      fallbackLanguage: 'en_us',
      order: ['querystring', 'cookie', 'header'],
      lookupQueryString: 'lang',
      lookupCookie: 'language',
      lookupFromHeaderKey: 'accept-language',
      convertDetectedLanguage: (lang) => matchLanguage(lang, supportedLanguages),
      caches: ['cookie'],
      cookieOptions: {
        sameSite: 'Lax',
        httpOnly: false,
        secure: false,
        maxAge: 365 * 24 * 60 * 60,
      },
    })
  )

  app.use(async (c, next) => {
    c.header('X-Powered-By', `nZip ${Config.version}`)
    // Bun loses the connection info once the response is sent
    const ip = getIP(c)
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'SAMEORIGIN')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    setImmediate(() => {
      Log.info(`${c.req.method} ${c.req.path} ${c.res.status} - ${clientTag(ip)}`)
    })
  })

  // 503 while draining, so the load balancer stops routing here
  app.get('/healthz', (c) => {
    if (WSHandler.isDraining()) return c.text('draining', 503)
    return c.text('ok')
  })

  app.on('GET', ['/', '/home'], (c) => StaticPage(c, 'Home', { version: Config.version, api: Config.apiHost }))

  app.get('/terms', (c) => StaticPage(c, 'Terms'))

  app.get('/privacy', (c) => StaticPage(c, 'Privacy'))

  app.get('/dmca', (c) => StaticPage(c, 'DMCA'))

  app.get('/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    const sorts: SearchSort[] = ['date', 'popular-today', 'popular-week', 'popular-month', 'popular']
    const sort = sorts.find((value) => value === c.req.query('sort')) ?? 'date'
    const page = Math.min(Math.max(parseInt(c.req.query('page') ?? '1', 10) || 1, 1), 10000)
    const empty = { query, sort, page, numPages: 0, total: 0, results: [], api: Config.apiHost }

    if (!query) return Page(c, 'Search', empty)

    const direct = query.match(/^(?:(?:https?:\/\/)?(?:www\.)?nhentai\.(?:net|zip)\/g\/)?(\d+)\/?$/i)
    if (direct) return c.redirect(`/g/${direct[1]}`)

    const ip = getIP(c)
    if (!searchRateLimiter.allow(ip)) {
      c.header('Retry-After', String(searchRateLimiter.getRetryAfterSeconds(ip) || 60))
      c.status(429)
      return Page(c, 'Error', { error: 'Too many searches, please wait a minute.' })
    }

    try {
      const data = await nh.search(query, page, sort)
      const results = data.result
        .filter((gallery) => !gallery.blacklisted)
        .map((gallery) => ({
          id: gallery.id,
          title: gallery.english_title || gallery.japanese_title || String(gallery.id),
          thumbnail: `${Config.imageHost}/${gallery.thumbnail}`,
          width: gallery.thumbnail_width,
          height: gallery.thumbnail_height,
          pages: gallery.num_pages
        }))
      return Page(c, 'Search', { ...empty, numPages: data.num_pages, total: data.total, results })
    } catch (error) {
      Log.warn(`Search failed: ${error}`)
      c.status(502)
      return Page(c, 'Search', { ...empty, error: Languages.translate(getLang(c), 'Search', 'Search failed, please try again later.') })
    }
  })

  app.get('/g/:id', async (c) => {
    let id = c.req.param('id')
    if (!id || !Number(id)) {
      c.status(400)
      return Page(c, 'Error', {
        error: "That's not a Number 😭"
      })
    }

    try {
      const response = await nh.get(id)

      if (response.error) {
        c.status(404)
        return Page(c, 'Error', {
          error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?'
        })
      } else {
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        const cover = `${Config.imageHost}/${response.pages[0].path}`
        return Page(c, 'Download', { id, title, cover })
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Not Found') || error.message.includes('does not exist')) {
          c.status(404)
          return Page(c, 'Error', {
            error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?'
          })
        } else {
          c.status(500)
          return Page(c, 'Error', {
            error: 'Something went wrong while fetching the doujinshi, please try again later or go back to <a href="/">home</a>.'
          })
        }
      }
      c.status(500)
      return Page(c, 'Error', { error: 'An unexpected error occurred. Please go back to <a href="/">home</a>.' })
    }
  })

  app.on('GET', ['/g/:id/', '/g/:id/:any{.+}'], (c) => {
    const id = c.req.param('id')
    return c.redirect(`/g/${id}`)
  })

  if (Config.development) {
    app.get('/dev/livereload', upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => {
        if (ws.raw) LiveReload.add(ws.raw)
      },
      onClose: (_evt, ws) => {
        if (ws.raw) LiveReload.remove(ws.raw)
      }
    })))
  }

  app.get('/ws/g/:id', async (c, next) => {
    if (isLoopbackAddress(getConnInfo(c).remote.address)) {
      await next()
      return
    }

    const ip = getIP(c)
    if (!wsRateLimiter.allow(ip)) {
      const retry = wsRateLimiter.getRetryAfterSeconds(ip) || 60
      c.header('Retry-After', String(retry))
      c.status(429)
      return c.text('Too Many Requests')
    }
    await next()
  }, upgradeWebSocket((c) => {
    return WSHandler.handle(c)
  }))

  app.get('/download/:hash/:file', async (c) => {
    const hash = c.req.param('hash')
    const fileName = decodeURIComponent(c.req.param('file'))

    try {
      const filePath = sanitizePath(hash, downloadDir)
      const fileLoc = sanitizePath(fileName, path.join(downloadDir, hash))

      if (!filePath || !fileLoc || path.basename(fileLoc) !== fileName || path.basename(filePath) !== hash) throw new Error('Invalid path')

      const archiveContentType = getArchiveContentType(fileName)
      if (!archiveContentType) throw new Error('Invalid File')

      const archive = await archives.open(hash, fileName)
      if (!archive) throw new Error('File does not exist')

      const fileSize = archive.size
      const range = parseRangeHeader(c.req.header('Range'), fileSize)

      const responseHeaders: Record<string, string> = {
        'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'content-type': archiveContentType,
        'accept-ranges': 'bytes',
      }

      if (range.unsatisfiable) {
        responseHeaders['content-range'] = `bytes */${fileSize}`
        return new Response(null, { status: 416, headers: responseHeaders })
      }

      if (range.partial) {
        const effectiveEnd = range.end + 1
        responseHeaders['content-range'] = `bytes ${range.start}-${range.end}/${fileSize}`
        responseHeaders['content-length'] = String(effectiveEnd - range.start)
        return new Response(archive.stream(range.start, effectiveEnd), { status: 206, headers: responseHeaders })
      }

      responseHeaders['content-length'] = String(fileSize)
      return new Response(archive.stream(), { headers: responseHeaders })
    } catch {
      const match = fileName.match(/^\[(\d+)\](.*?)\.(zip|cbz|pdf|epub)$/i)
      c.status(404)
      let errorMessage = ''
      let id: string | undefined

      if (match) {
        id = match[1]
        errorMessage = 'The doujinshi with ID {id} is not available for download. You can go to <a href="/g/{id}">this page</a> and get a new link.'
      } else {
        errorMessage = 'That file does not exist. You can go back <a href="/">home</a> and get a new link.'
      }

      return Page(c, 'Error', {
        error: errorMessage,
        id
      })
    }
  })

  app.on('HEAD', '/download/:hash/:file', async (c) => {
    const hash = c.req.param('hash')
    const fileName = decodeURIComponent(c.req.param('file'))

    try {
      const filePath = sanitizePath(hash, downloadDir)
      const fileLoc = sanitizePath(fileName, path.join(downloadDir, hash))

      if (!filePath || !fileLoc || path.basename(fileLoc) !== fileName || path.basename(filePath) !== hash) throw new Error('Invalid path')
      const archiveContentType = getArchiveContentType(fileName)
      if (!archiveContentType) throw new Error('Invalid File')

      const file = await archives.open(hash, fileName)
      if (!file) throw new Error('File does not exist')
      const range = parseRangeHeader(c.req.header('Range'), file.size)

      if (range.unsatisfiable) {
        return new Response(null, {
          status: 416,
          headers: {
            'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'content-type': archiveContentType,
            'accept-ranges': 'bytes',
            'content-range': `bytes */${file.size}`,
          },
        })
      }

      if (range.partial) {
        return new Response(null, {
          status: 206,
          headers: {
            'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'content-type': archiveContentType,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${range.start}-${range.end}/${file.size}`,
            'content-length': String(range.end - range.start + 1),
          },
        })
      }

      return new Response(null, {
        status: 200,
        headers: {
          'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'content-type': archiveContentType,
          'accept-ranges': 'bytes',
          'content-length': String(file.size),
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })

  app.get('/Scripts/:script', (c) =>
    Static(c, 'script', 'Scripts', 'text/javascript', {
      error: "console.error('Script Not Found')"
    })
  )

  app.get('/Styles/:style', (c) =>
    Static(c, 'style', 'Styles', 'text/css', {
      error: 'What style? Do you mean <a href="/g/228922">this</a>?'
    })
  )

  app.get('/Images/:image', (c) =>
    Static(c, 'image', 'Images', 'auto', {
      error: "The image you're trying to find does not exist. You probably have some mental disorders, please contact your doctor for professional help."
    }, 'public, max-age=31536000, immutable')
  )

  app.get('/Languages', (c) => {
    return c.json(Languages.getAvailableLanguages())
  })

  app.get('/error', (c) => {
    c.status(404)
    return Page(c, 'Error', {
      error: 'Don\'t tell anyone but I got some <a href="/g/228922">good stuff</a> for you :)'
    })
  })

  app.get('/favicon.ico', async (c) => {
    return c.redirect('/Images/icon.ico')
  })

  app.get('/robots.txt', async (c) => {
    const robotsPath = path.join(process.cwd(), `${filePath}/robots.txt`)
    try {
      if (!(await Bun.file(robotsPath).exists())) throw new Error('robots.txt does not exist')
      return new Response(Bun.file(robotsPath), {
        headers: {
          'Content-Type': 'text/plain'
        }
      })
    } catch (error) {
      return c.text('User-agent: *\nDisallow: /', 200, {
        'Content-Type': 'text/plain'
      })
    }
  })

  app.notFound(async (c) => {
    return c.redirect('/error')
  })

  Log.info('Starting nZip Server...')

  const server = Bun.serve({
    port: Config.httpPort,
    fetch: app.fetch,
    websocket,
    reusePort: true,
    development: false,
    maxRequestBodySize: 1024 * 1024 * 10 // 10MB
  })

  Log.success(`nZip running on ${Config.httpHost}/`)

  return async () => {
    Log.info('Shutting down server...')

    const deadline = Date.now() + Config.drainTimeoutMs
    archiveCron?.stop()

    try {
      await WSHandler.drain(Config.drainTimeoutMs)
      Log.info('Running downloads drained')
    } catch (error) {
      Log.error(`Error draining downloads: ${error}`)
    }

    core.prepareForShutdown()

    try {
      await WSHandler.close()
      Log.info('WebSocket handler closed')
    } catch (error) {
      Log.error(`Error closing WebSocket handler: ${error}`)
    }

    try {
      const remaining = Math.max(deadline - Date.now(), 1000)
      const stopped = await Promise.race([
        server.stop(false).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining))
      ])
      if (!stopped) await server.stop(true)
      Log.info('Server stopped')
    } catch (error) {
      Log.error(`Error stopping server: ${error}`)
    }

    try {
      await core.close()
      Log.info('Core closed')
    } catch (error) {
      Log.error(`Error closing core: ${error}`)
    }

    try {
      await sessionStore.close()
      Log.info('Session store closed')
    } catch (error) {
      Log.error(`Error closing session store: ${error}`)
    }

    archives.close()

    try {
      Languages.shutdown()
    } catch (error) {
      Log.error(`Error closing language watcher: ${error}`)
    }

    try {
      Pages.shutdown()
    } catch (error) {
      Log.error(`Error closing page watcher: ${error}`)
    }

    try {
      LiveReload.shutdown()
    } catch (error) {
      Log.error(`Error closing live reload channel: ${error}`)
    }

    try {
      Scripts.shutdown()
    } catch (error) {
      Log.error(`Error closing script watcher: ${error}`)
    }

    Log.success('Shutdown complete')
  }
}

/**
 * Get the IP address of the client
 * @param c Context containing request and response information
 * @returns The IP address as a string
 */
export function getIP(c: Context): string {
  try {
    const remoteAddress = parseIPAddress(getConnInfo(c).remote.address)

    if (Config.trustXForwardedFor && remoteAddress && isTrustedProxy(remoteAddress, trustedProxyRules)) {
      // Set by Cloudflare, not the visitor
      const cloudflare = parseIPAddress(c.req.header('CF-Connecting-IP'))
      if (cloudflare) {
        return cloudflare.normalized
      }

      // Visitors can prepend their own entries: use the last address that is not our proxy
      const forwardedFor = c.req.header('X-Forwarded-For')
      if (forwardedFor) {
        const chain = forwardedFor.split(',').map((entry) => parseIPAddress(entry.trim())).filter((entry) => entry !== null)
        const visitor = [...chain].reverse().find((entry) => !isTrustedProxy(entry, trustedProxyRules)) ?? chain[0]
        if (visitor) {
          return visitor.normalized
        }
      }
    }

    return remoteAddress?.normalized || 'unknown'
  } catch {
    return 'unknown'
  }
}

function getArchiveContentType(fileName: string): string | null {
  if (fileName.endsWith('.zip')) return 'application/zip'
  if (fileName.endsWith('.cbz')) return 'application/vnd.comicbook+zip'
  if (fileName.endsWith('.pdf')) return 'application/pdf'
  if (fileName.endsWith('.epub')) return 'application/epub+zip'
  return null
}

/**
 * Sanitize a user input path to prevent directory traversal attacks
 * @param userInput The user input path
 * @param baseDir The base directory to resolve against
 * @returns The sanitized path or null if the path is invalid
 */
function sanitizePath(userInput: string, baseDir: string): string | null {
  const normalized = userInput.replace(/\\/g, '/')

  const basePath = path.isAbsolute(baseDir) ? path.resolve(baseDir) : path.resolve(path.join(process.cwd(), baseDir))
  const fullPath = path.resolve(path.join(basePath, normalized))
  const relative = path.relative(basePath, fullPath)

  if (relative === '' || relative === '.') {
    return fullPath
  }

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }

  return fullPath
}

/**
 * Map a language tag to a language file ("ja" → ja_jp, "es-MX" → es_es, "zh-Hans" → zh_cn)
 * @param lang Language tag
 * @param supported Available language codes
 * @returns The matching code, or the normalized tag
 */
function matchLanguage(lang: string, supported: string[]): string {
  const code = lang.toLowerCase().replace(/-/g, '_')
  if (supported.includes(code)) return code

  const [base, ...rest] = code.split('_')
  if (base === 'zh') {
    const traditional = rest.some((part) => ['tw', 'hk', 'mo', 'hant'].includes(part))
    const target = traditional ? 'zh_tw' : 'zh_cn'
    return supported.includes(target) ? target : code
  }

  const alias = base === 'in' ? 'id' : base
  return supported.find((candidate) => candidate.split('_')[0] === alias) ?? code
}

/**
 * Get language of the user from the context.
 * @param c Context containing request and response information
 * @returns Language code (defaults to 'en_us')
 */
export function getLang(c: AppContext): string {
  return c.get('language')
}

/**
 * Serve a static file from a directory
 * @param c Context containing request and response information
 * @param paramName The name of the URL parameter containing the file name
 * @param dir The directory to serve files from
 * @param contentType The content type of the file
 * @param errorPage The error page data to use if the file is not found
 * @param cacheControl Optional Cache-Control header value
 * @returns A Response object containing the file or an error page
 */
async function Static(c: AppContext, paramName: string, dir: string, contentType: string, errorPage: Record<string, unknown>, cacheControl?: string): Promise<Response> {
  try {
    const fileName = c.req.param(paramName)
    if (!fileName) throw new Error('No file specified')
    const fullPath = sanitizePath(fileName, `${filePath}/${dir}`)

    if (!fullPath) throw new Error()

    if (!(await Bun.file(fullPath).exists())) throw new Error('File does not exist')
    const bunFile = Bun.file(fullPath)
    const headers: Record<string, string> = {
      'Content-Type': contentType === 'auto' ? bunFile.type : contentType
    }
    if (cacheControl) {
      headers['Cache-Control'] = cacheControl
    }
    return new Response(bunFile, { headers })
  } catch {
    c.status(404)
    return Page(c, 'Error', errorPage)
  }
}

/**
 * Serve a cached static page
 * @param c Context containing request and response information
 * @param pagename The name of the page to serve
 * @param args Optional arguments to pass to the page
 * @returns A Response object containing the cached page
 */
function StaticPage(c: AppContext, pagename: PageName, args?: Record<string, unknown>): Response {
  const lang = getLang(c)
  const cacheKey = `${pagename}:${lang}:${args ? JSON.stringify(args) : ''}`

  let cached = CacheStore.get(cacheKey)
  if (cached) {
    return c.html(cached)
  }

  const html = RenderPage(c, pagename, args)
  if (CacheStore.size >= CACHE_MAX_SIZE) {
    const oldestKey = CacheStore.keys().next().value
    if (oldestKey !== undefined) CacheStore.delete(oldestKey)
  }
  CacheStore.set(cacheKey, html)
  return c.html(html)
}

/**
 * Serve the HTML of a page
 * @param c Context containing request and response information
 * @param pagename The name of the page to render
 * @param args Optional arguments to pass to the page
 * @returns A string containing the rendered HTML of the page
 */
function Page(c: AppContext, pagename: PageName, args?: null | Record<string, unknown>): Response {
  const html = RenderPage(c, pagename, args)
  return c.html(html)
}

/**
 * Render a page and return HTML string
 * @param page The page to render
 * @param args Optional arguments to pass to the page
 * @returns A string containing the rendered HTML of the page
 */
function RenderPage(c: AppContext, pagename: PageName, args?: null | Record<string, unknown>): string {
  try {
    const lang = getLang(c)
    const Args = {
      ...args,
      t: (key: string) => Languages.translate(lang, pagename, key),
      tr: (section: string, key: string) => Languages.translate(lang, section, key),
      script: (name: string) => Scripts.getScript(name)
    }

    return Pages.page(pagename, Args).render({ analytics, lang })
  } catch (error) {
    setImmediate(() => Log.error(error))
    return '<!DOCTYPE html><html><body>Page Not Found</body></html>'
  }
}
