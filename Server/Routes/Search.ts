import type { Hono } from 'hono'

import Config from '../../Config'

import Languages from '../Modules/Language'
import { Page, getLang, type AppEnv } from '../Render'
import { getIP } from '../Tools/ClientIP'
import Log from '../Tools/Log'
import { rateLimited } from '../Tools/Metrics'
import RateLimiter from '../Tools/RateLimiter'
import type NH from '../Tools/nh'
import type { SearchSort } from '../Tools/nh'

const SORTS: SearchSort[] = ['date', 'popular-today', 'popular-week', 'popular-month', 'popular']

export default function registerSearch(app: Hono<AppEnv>, deps: { nh: NH }): void {
  // A person searches in bursts; a scraper pages steadily. Allow a burst of 1.5 minutes' worth, then the
  // per-minute rate, and cap the hour so a steady crawl stops early.
  const searchBurst = Math.ceil(Config.searchRateLimit * 1.5)
  const searchLimiters = [Config.searchRateLimit > 0 && new RateLimiter(searchBurst, (searchBurst / Config.searchRateLimit) * 60 * 1000), Config.searchHourlyLimit > 0 && new RateLimiter(Config.searchHourlyLimit, 60 * 60 * 1000)].filter((limiter) => limiter !== false)

  app.get('/search', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 200)
    const sort = SORTS.find((value) => value === c.req.query('sort')) ?? 'date'
    const page = Math.min(Math.max(parseInt(c.req.query('page') ?? '1', 10) || 1, 1), 10000)
    const empty = { query, sort, page, numPages: 0, total: 0, results: [], api: Config.apiHost }

    if (!query) return Page(c, 'Search', empty)

    const direct = query.match(/^(?:(?:https?:\/\/)?(?:www\.)?nhentai\.(?:net|zip)\/g\/)?(\d+)\/?$/i)
    if (direct) return c.redirect(`/g/${direct[1]}`)

    const ip = getIP(c)
    const limited = searchLimiters.find((limiter) => !limiter.allow(ip))
    if (limited) {
      const seconds = limited.getRetryAfterSeconds(ip) || 60
      rateLimited.inc({ kind: 'search' })
      c.header('Retry-After', String(seconds))
      c.status(429)
      // The search page, so the form keeps the query
      const error = Languages.translate(getLang(c), 'Search', 'Too many searches. Please wait {seconds} seconds and try again.').replace('{seconds}', String(seconds))
      return Page(c, 'Search', { ...empty, error })
    }

    try {
      const data = await deps.nh.search(query, page, sort)
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
}
