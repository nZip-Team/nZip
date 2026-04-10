import Bun from 'bun'
import { Hono, type Context } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { getConnInfo } from 'hono/bun'
import { languageDetector } from 'hono/language'

import fs from 'fs'
import path from 'path'

import Config from '../Config'

import nhget from './Modules/nhget'
import Log from './Modules/Log'

import Pages, { type PageName } from './Modules/Pages'
import WebSocketHandler from './WebSocket'
import RateLimiter from './RateLimiter'
import Languages from './Modules/Language'
import Scripts from './Modules/Scripts'
import { Core } from './Modules/Core'

type AppEnv = { Variables: { language: string } }
type AppContext = Context<AppEnv>

let analytics: string | null = null

let filePath = './App'

const CacheStore = new Map<string, string>()
const CACHE_MAX_SIZE = 200

// In development, flush all CacheStore entries for a page when it is reloaded
if (process.env['NODE_ENV'] === 'development') {
  Pages.onReload((pageName) => {
    for (const key of Array.from(CacheStore.keys())) {
      if (key.startsWith(`${pageName}:`)) CacheStore.delete(key)
    }
    Log.info(`Cache cleared for page: ${pageName}`)
  })
}

const downloadDir = path.join(process.cwd(), fs.existsSync(path.join(process.cwd(), 'Server')) ? 'Server' : '', 'Cache', 'Downloads')
if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir, { recursive: true })
}

/**
 * Start the server
 */
export default async (): Promise<() => Promise<void>> => {
  const nh = new nhget({
    endpoint: `${Config.apiHost}/api/v2/galleries/`,
    imageEndpoint: `${Config.imageHost}/galleries/`
  })

  const core = new Core()
  await core.start()
  const sessionStore = core.sessionStore

  const WSHandler = new WebSocketHandler(
    nh,
    downloadDir,
    sessionStore,
    core.downloadManager
  )

  const wsRateLimiter = new RateLimiter(Config.rateLimit, 60 * 1000)

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
      convertDetectedLanguage: (lang) => lang.toLowerCase().replace(/-/g, '_'),
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
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'SAMEORIGIN')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    setImmediate(() => {
      Log.info(`${c.req.method} ${c.req.path} ${c.res.status} - ${getIP(c)}`)
    })
  })

  app.on('GET', ['/', '/home'], (c) => StaticPage(c, 'Home', { version: Config.version }))

  app.get('/terms', (c) => StaticPage(c, 'Terms'))

  app.get('/privacy', (c) => StaticPage(c, 'Privacy'))

  app.get('/dmca', (c) => StaticPage(c, 'DMCA'))

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

  app.get('/ws/g/:id', async (c, next) => {
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

      if (!filePath || !fileLoc) throw new Error('Invalid path')

      if (!fileName.endsWith('.zip')) throw new Error('Invalid File')
      if (!(await Bun.file(fileLoc).exists())) throw new Error('File does not exist')

      const rangeHeader = c.req.header('Range')
      const [start, end] = parseRangeHeader(rangeHeader)

      const file = Bun.file(fileLoc)
      const fileSize = file.size
      const effectiveEnd = end === Infinity ? fileSize : Math.min(end + 1, fileSize)

      const responseHeaders: Record<string, string> = {
        'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'content-type': 'application/zip',
        'accept-ranges': 'bytes',
      }

      if (rangeHeader) {
        responseHeaders['content-range'] = `bytes ${start}-${effectiveEnd - 1}/${fileSize}`
        responseHeaders['content-length'] = String(effectiveEnd - start)
        return new Response(file.slice(start, effectiveEnd), { status: 206, headers: responseHeaders })
      }

      responseHeaders['content-length'] = String(fileSize)
      return new Response(file, { headers: responseHeaders })
    } catch {
      const match = fileName.match(/^\[(\d+)\](.*?)\.zip$/)
      c.status(404)
      let errorMessage = ''

      if (match) {
        const galleryID = match[1]
        errorMessage = `The doujinshi with ID ${galleryID} is not available for download. You can go to <a href="/g/${galleryID}">this page</a> and get a new link.`
      } else {
        errorMessage = 'That file does not exist. You can go back <a href="/">home</a> and get a new link.'
      }

      return Page(c, 'Error', {
        error: errorMessage
      })
    }
  })

  app.on('HEAD', '/download/:hash/:file', async (c) => {
    const hash = c.req.param('hash')
    const fileName = decodeURIComponent(c.req.param('file'))

    try {
      const filePath = sanitizePath(hash, downloadDir)
      const fileLoc = sanitizePath(fileName, path.join(downloadDir, hash))

      if (!filePath || !fileLoc) throw new Error('Invalid path')
      if (!fileName.endsWith('.zip')) throw new Error('Invalid File')

      const file = Bun.file(fileLoc)
      if (!(await file.exists())) throw new Error('File does not exist')

      return new Response(null, {
        status: 200,
        headers: {
          'content-disposition': `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'content-type': 'application/zip',
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

    core.prepareForShutdown()
    
    try {
      server.stop(true)
      Log.info('Server stopped')
    } catch (error) {
      Log.error(`Error stopping server: ${error}`)
    }

    try {
      await WSHandler.close()
      Log.info('WebSocket handler closed')
    } catch (error) {
      Log.error(`Error closing WebSocket handler: ${error}`)
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
    const forwardedFor = c.req.header('X-Forwarded-For')
    if (forwardedFor) {
      const candidate = forwardedFor.split(',')[0].trim()
      if (/^[0-9a-fA-F:.]{1,45}$/.test(candidate)) return candidate
    }
    return getConnInfo(c).remote.address || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Parse the Range header from the request
 * @param rangeHeader The Range header value
 * @returns A tuple containing the start and end of the range
 */
function parseRangeHeader(rangeHeader: string | undefined): [number, number] {
  if (!rangeHeader) return [0, Infinity]

  try {
    const rangeValue = rangeHeader.split('=')[1]
    if (!rangeValue) return [0, Infinity]

    const [startStr, endStr] = rangeValue.split('-')
    const startNum = startStr ? parseInt(startStr, 10) : 0
    const endNum = endStr ? parseInt(endStr, 10) : Infinity

    if (isNaN(startNum)) return [0, endNum]
    if (isNaN(endNum)) return [startNum, Infinity]

    return [startNum, endNum]
  } catch (error) {
    return [0, Infinity]
  }
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

  if (!fullPath.startsWith(basePath)) {
    return null
  }

  return fullPath
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
      script: (name: string) => Scripts.getScript(name)
    }

    return Pages.page(pagename, Args).render({ analytics, lang })
  } catch (error) {
    setImmediate(() => Log.error(error))
    return '<!DOCTYPE html><html><body>Page Not Found</body></html>'
  }
}
