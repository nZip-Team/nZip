import Bun from 'bun'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { languageDetector } from 'hono/language'

import fs from 'fs'
import path from 'path'

import WebSocketHandler from './WebSocket'

import Config from '../Config'

import NH from './Tools/nh'
import Log, { clientTag } from './Tools/Log'
import { getIP, isInternalRequest } from './Tools/ClientIP'
import Metrics, { httpRequests } from './Tools/Metrics'
import { buildContentSecurityPolicy } from './Tools/SecurityHeaders'
import { PRECONNECT_LINK } from './Tools/Preconnect'
import { EDGE_CACHE_CONTROL, isEdgeCacheable } from './Tools/EdgeCache'

import Pages from './Modules/Pages'
import Languages from './Modules/Language'
import Scripts from './Modules/Scripts'
import { Core } from './Modules/Core'
import LiveReload from './Modules/LiveReload'
import ArchiveStore from './Storage'
import Lease from './Storage/Lease'
import { processID } from './Runtime'

import { watchForReloads, type AppEnv } from './Render'
import registerPages from './Routes/Pages'
import registerSearch from './Routes/Search'
import registerDownload, { activeDownloads, waitForDownloads } from './Routes/Download'
import registerStatic from './Routes/Static'
import registerWebSocket from './Routes/WS'

const appDir = path.join(process.cwd(), 'App')

const downloadDir = path.join(process.cwd(), fs.existsSync(path.join(process.cwd(), 'Server')) ? 'Server' : '', 'Cache', 'Downloads')
if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir, { recursive: true })
}

// Not worth a log line each: the load balancer and Prometheus poll these
const QUIET_PATHS = new Set(['/healthz', '/metrics'])
// Download links run on after the drain, as long as the stop budget allows
const DOWNLOAD_GRACE_MS = 15000

/** Bounded route label for metrics */
function routeLabel(pathname: string): string {
  if (pathname === '/' || pathname === '/home') return '/'
  if (/^\/(terms|privacy|dmca|search|healthz|metrics|Languages|error|favicon\.ico|robots\.txt|manifest\.webmanifest)$/.test(pathname)) return pathname
  const prefix = pathname.match(/^\/(g|ws\/g|download|Scripts|Styles|Images|dev)\//)
  if (prefix) return `/${prefix[1]}/*`
  return 'other'
}

/**
 * Start the server
 */
export default async (): Promise<() => Promise<void>> => {
  const nh = new NH(Config.apiHost)

  const core = new Core()
  await core.start()
  const sessionStore = core.sessionStore

  const cacheDir = path.dirname(downloadDir)
  const archives = new ArchiveStore(downloadDir, cacheDir)
  if (archives.remote) {
    Log.info(`Archives are stored in S3 bucket ${Config.s3.bucket} (retention ${Config.archiveRetentionDays || '∞'} days, cap ${Config.archiveMaxGB || '∞'} GB)`)
  }
  const lease = new Lease(cacheDir, processID)

  const WSHandler = new WebSocketHandler(nh, downloadDir, sessionStore, core.downloadManager, archives, lease)

  if (Config.development) watchForReloads(appDir)

  Metrics.gauge('nzip_build_info', 'Version of this instance', () => [[{ version: Config.version }, 1]])
  Metrics.gauge('nzip_ws_sessions', 'Download sessions held by this instance', () => WSHandler.stats().sessions)
  Metrics.gauge('nzip_ws_clients', 'Open download page sockets', () => WSHandler.stats().clients)
  Metrics.gauge('nzip_downloads_in_flight', 'Galleries this instance is downloading', () => WSHandler.stats().downloads)
  Metrics.gauge('nzip_formats_in_flight', 'Archive formats this instance is packing', () => WSHandler.stats().packing)
  Metrics.gauge('nzip_download_streams_active', 'Archive downloads being sent', () => activeDownloads())
  Metrics.gauge('nzip_draining', '1 while this instance shuts down', () => (WSHandler.isDraining() ? 1 : 0))
  Metrics.gauge('nzip_core_up', '1 while the Go core runs', () => (core.isAlive() ? 1 : 0))

  const contentSecurityPolicy = buildContentSecurityPolicy({ apiHost: Config.apiHost, imageHost: Config.imageHost, analytics: Config.analytics, override: Config.contentSecurityPolicy })
  const https = Config.httpHost.startsWith('https:')

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
        maxAge: 365 * 24 * 60 * 60
      }
    })
  )

  app.use(async (c, next) => {
    c.header('X-Powered-By', 'nZip')
    // Bun loses the connection info once the response is sent
    const ip = getIP(c)
    await next()
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'SAMEORIGIN')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    if (https) c.header('Strict-Transport-Security', 'max-age=31536000')
    if (c.res.headers.get('content-type')?.startsWith('text/html')) {
      if (contentSecurityPolicy) c.header('Content-Security-Policy', contentSecurityPolicy(c.req.header('Host')))
      if (PRECONNECT_LINK) c.header('Link', PRECONNECT_LINK)
      if (isEdgeCacheable(c.req.method, c.req.path, c.res.status, c.req.header('Cookie'), c.res.headers.has('Set-Cookie'))) {
        // A CDN rule that honours the origin's Cache-Control may keep this for a short time; browsers always revalidate
        c.header('Cache-Control', EDGE_CACHE_CONTROL)
      }
    }

    const status = c.res.status
    httpRequests.inc({ route: routeLabel(c.req.path), method: c.req.method, status: String(status) })
    if (!QUIET_PATHS.has(c.req.path)) {
      setImmediate(() => {
        Log.info(`${c.req.method} ${c.req.path} ${status} - ${clientTag(ip)}`)
      })
    }
  })

  // 503 while draining or without a working core, so the load balancer routes elsewhere
  app.get('/healthz', async (c) => {
    if (WSHandler.isDraining()) return c.text('draining', 503)
    if (!(await core.ping(1500))) return c.text('core unavailable', 503)
    return c.text('ok')
  })

  // Internal only: requests through Cloudflare never get it
  app.get('/metrics', (c) => {
    if (!isInternalRequest(c)) return c.text('Not Found', 404)
    return c.body(Metrics.render(), 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' })
  })

  registerPages(app, { nh, appDir })
  registerSearch(app, { nh })
  registerWebSocket(app, { handler: WSHandler })
  registerDownload(app, { archives, downloadDir })
  registerStatic(app, { appDir })

  app.notFound((c) => c.redirect('/error'))

  Log.info('Starting nZip Server...')

  const server = Bun.serve({
    port: Config.httpPort,
    fetch: app.fetch,
    // Clients only send small JSON commands
    websocket: { ...websocket, maxPayloadLength: 4096 },
    reusePort: true,
    development: false,
    // No route takes a request body
    maxRequestBodySize: 64 * 1024
  })

  Log.success(`nZip running on ${Config.httpHost}/`)

  return async () => {
    Log.info('Shutting down server...')

    const started = Date.now()
    const budgetEnd = started + Config.shutdownBudgetMs

    // New requests already go to the other instance (/healthz says draining); finish what runs here
    try {
      await Promise.all([WSHandler.drain(Config.drainTimeoutMs), waitForDownloads(Math.min(started + Config.drainTimeoutMs + DOWNLOAD_GRACE_MS, budgetEnd - 5000))])
      Log.info(`Running downloads drained (${activeDownloads()} file download(s) still open)`)
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
      const remaining = Math.max(budgetEnd - 5000 - Date.now(), 1000)
      const stopped = await Promise.race([server.stop(false).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining))])
      if (!stopped) await server.stop(true)
      Log.info('Server stopped')
    } catch (error) {
      Log.error(`Error stopping server: ${error}`)
    }

    // Last: the core finishes its own jobs, within what is left of the budget
    try {
      await core.close(Math.min(65000, Math.max(budgetEnd - Date.now(), 3000)))
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
    lease.close()

    for (const [name, close] of [
      ['language watcher', () => Languages.shutdown()],
      ['page watcher', () => Pages.shutdown()],
      ['live reload channel', () => LiveReload.shutdown()],
      ['script watcher', () => Scripts.shutdown()]
    ] as const) {
      try {
        close()
      } catch (error) {
        Log.error(`Error closing ${name}: ${error}`)
      }
    }

    Log.success('Shutdown complete')
  }
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
