import path from 'path'
import type { Hono } from 'hono'

import Config from '../../Config'

import Languages from '../Modules/Language'
import { Page, StaticPage, type AppEnv, type AppContext } from '../Render'
import { canonicalGalleryID } from '../Tools/GalleryID'
import Log from '../Tools/Log'
import type NH from '../Tools/nh'

const NOT_FOUND = 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?'

export default function registerPages(app: Hono<AppEnv>, deps: { nh: NH; appDir: string }): void {
  app.on('GET', ['/', '/home'], (c) => StaticPage(c, 'Home', { version: Config.version, api: Config.apiHost }))

  app.get('/terms', (c) => StaticPage(c, 'Terms'))

  app.get('/privacy', (c) => StaticPage(c, 'Privacy'))

  app.get('/dmca', (c) => StaticPage(c, 'DMCA'))

  app.get('/g/:id', async (c) => {
    const raw = c.req.param('id')
    const id = canonicalGalleryID(raw)
    if (!id) return notAGallery(c)
    // /g/0123 and /g/123 are one gallery and must share its session
    if (id !== raw) return c.redirect(`/g/${id}${new URL(c.req.url).search}`, 301)

    try {
      const response = await deps.nh.get(id)

      if (response.error) {
        c.status(404)
        return Page(c, 'Error', { error: NOT_FOUND })
      }

      const title = response.title.english || response.title.japanese || response.title.pretty || null
      const cover = `${Config.imageHost}/${response.pages[0]?.path}`
      return Page(c, 'Download', { id, title, cover })
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('status: 404') || error.message.includes('Not Found') || error.message.includes('does not exist')) {
          c.status(404)
          return Page(c, 'Error', { error: NOT_FOUND })
        }
        Log.warn(`Gallery lookup failed for ${id}: ${error.message}`)
        c.status(502)
        return Page(c, 'Error', {
          error: 'Something went wrong while fetching the doujinshi, please try again later or go back to <a href="/">home</a>.'
        })
      }
      c.status(500)
      return Page(c, 'Error', { error: 'An unexpected error occurred. Please go back to <a href="/">home</a>.' })
    }
  })

  app.on('GET', ['/g/:id/', '/g/:id/:any{.+}'], (c) => {
    const id = canonicalGalleryID(c.req.param('id'))
    if (!id) return notAGallery(c)
    return c.redirect(`/g/${id}`)
  })

  app.get('/Languages', (c) => c.json(Languages.getAvailableLanguages()))

  app.get('/error', (c) => {
    c.status(404)
    return Page(c, 'Error', {
      error: 'Don\'t tell anyone but I got some <a href="/g/228922">good stuff</a> for you :)'
    })
  })

  app.get('/favicon.ico', (c) => c.redirect('/Images/icon.ico'))

  app.get('/manifest.webmanifest', async (c) => {
    const manifest = Bun.file(path.join(deps.appDir, 'manifest.webmanifest'))
    if (!(await manifest.exists())) return c.text('Not Found', 404)
    return new Response(manifest, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' } })
  })

  app.get('/robots.txt', async (c) => {
    const robotsPath = path.join(deps.appDir, 'robots.txt')
    if (await Bun.file(robotsPath).exists()) {
      return new Response(Bun.file(robotsPath), { headers: { 'Content-Type': 'text/plain' } })
    }
    return c.text('User-agent: *\nDisallow: /', 200, { 'Content-Type': 'text/plain' })
  })
}

function notAGallery(c: AppContext): Response {
  c.status(404)
  return Page(c, 'Error', { error: "That's not a Number 😭" })
}
