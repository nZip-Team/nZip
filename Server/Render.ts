import path from 'path'
import type { Context } from 'hono'

import Config from '../Config'

import Log from './Tools/Log'
import Pages, { type PageName } from './Modules/Pages'
import Languages from './Modules/Language'
import Scripts from './Modules/Scripts'
import LiveReload from './Modules/LiveReload'

export type AppEnv = { Variables: { language: string } }
export type AppContext = Context<AppEnv>

const analytics: string | null = Config.analytics || null

const CacheStore = new Map<string, string>()
const CACHE_MAX_SIZE = 200

/** In development, drop rendered pages when their source changes */
export function watchForReloads(appDir: string): void {
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
  LiveReload.watchStyles(path.join(appDir, 'Styles'))
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
 * Serve a page that only depends on its arguments and the language, rendered once
 * @param c Context containing request and response information
 * @param pagename The name of the page to serve
 * @param args Optional arguments to pass to the page
 * @returns A Response object containing the cached page
 */
export function StaticPage(c: AppContext, pagename: PageName, args?: Record<string, unknown>): Response {
  const lang = getLang(c)
  const cacheKey = `${pagename}:${lang}:${args ? JSON.stringify(args) : ''}`

  const cached = CacheStore.get(cacheKey)
  if (cached) return c.html(cached)

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
 * @returns A Response object containing the rendered page
 */
export function Page(c: AppContext, pagename: PageName, args?: null | Record<string, unknown>): Response {
  return c.html(RenderPage(c, pagename, args))
}

/**
 * Render a page and return HTML string
 * @param c Context containing request and response information
 * @param pagename The page to render
 * @param args Optional arguments to pass to the page
 * @returns A string containing the rendered HTML of the page
 */
export function RenderPage(c: AppContext, pagename: PageName, args?: null | Record<string, unknown>): string {
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
