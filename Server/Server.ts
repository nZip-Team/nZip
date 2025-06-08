import Bun, { type ServerWebSocket } from 'bun'
import { Hono, type Context } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { getConnInfo } from 'hono/bun'

import { existsSync, promises as fs } from 'fs'
import path from 'path'

import { Scope, type ElementAttributes } from '@lightbery/scope'
import nhget, { type GalleryData } from '@icebrick/nhget'
import Log from '@icebrick/log'

import Pages from './Pages'
import WebSocketHandler from './WebSocket'
import type { RenderScope, Page as PageModule } from './Types'

let analytics: ElementAttributes | null = null
const scope: RenderScope = new Scope(undefined)

let filePath = './App'
if (!existsSync(path.join(__dirname, filePath))) filePath = '../App'

let downloadPath = './Server/Cache/Downloads'
if (!existsSync(path.join(__dirname, downloadPath))) downloadPath = './Cache/Downloads'

/**
 * Start the server
 * @param host Hostname (which will only be used for logging)
 * @param port Port
 * @param apiHost API host
 * @param imageHost Image host
 * @param analytic Analytics data
 * @param version nZip version
 */
export default (host: string, port: number, apiHost: string, imageHost: string, analytic: string, version: string) => {
  const nh = new nhget({
    endpoint: `${apiHost}/api/gallery/`,
    imageEndpoint: `${imageHost}/galleries/`
  })

  analytics = analytic ? (JSON.parse(analytic) as ElementAttributes) : null

  const app = new Hono()
  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()

  app.use(async (c, next) => {
    c.header('X-Powered-By', 'nZip')
    await next()
    Log.info(`${c.req.method} ${c.req.path} ${c.res.status} - ${getIP(c)}`)
  })

  app.on('GET', ['/', '/home'], (c) => {
    return c.html(renderPage(Pages.getPage('Home'), { version }))
  })

  app.get('/terms', (c) => {
    return c.html(renderPage(Pages.getPage('Terms')))
  })

  app.get('/privacy', (c) => {
    return c.html(renderPage(Pages.getPage('Privacy')))
  })

  app.get('/g/:id', async (c) => {
    let id = c.req.param('id')
    if (!id || !Number(id)) {
      c.status(400)
      return c.html(renderPage(Pages.getPage('Error'), { error: "That's not a Number 😭" }))
    }

    try {
      const response: GalleryData = (await nh.get(id)) as GalleryData

      if (response.error) {
        c.status(404)
        return c.html(renderPage(Pages.getPage('Error'), { error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?' }))
      } else {
        const extension = response.images.pages[0].t === 'j' ? 'jpg' : response.images.pages[0].t === 'g' ? 'gif' : response.images.pages[0].t === 'w' ? 'webp' : 'png'
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        const cover = `${imageHost}/galleries/${response.media_id}/1.${extension}`
        return c.html(renderPage(Pages.getPage('Download'), { id, title, cover }))
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Not Found') || error.message.includes('does not exist')) {
          c.status(404)
          return c.html(renderPage(Pages.getPage('Error'), { error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?' }))
        } else {
          c.status(500)
          return c.html(renderPage(Pages.getPage('Error'), { error: 'An error occurred while fetching the gallery.' }))
        }
      }
    }
  })

  app.get('/g/:id/*any', (c) => {
    const id = c.req.param('id')
    return c.redirect(`/g/${id}`)
  })

  app.get('/ws/g/:id', upgradeWebSocket((c) => {
    return new WebSocketHandler(nh, imageHost).handle(c)
  }))

  app.get('/download/:hash/:file', async (c) => {
    const filePath = path.join(__dirname, 'Cache', 'Downloads', c.req.param('hash'), c.req.param('file'))

    try {
      if (!c.req.param('file').endsWith('.zip')) throw new Error('Invalid File')
      await fs.access(filePath)
      return new Response(Bun.file(filePath))
    } catch {
      c.status(404)
      return c.html(renderPage(Pages.getPage('Error'), { error: 'That file does not exist. You can go back <a href="/">home</a> and get a new link.' }))
    }
  })

  app.get('/Scripts/:script', async (c) => {
    const scriptName = c.req.param('script')
    const scriptPath = path.join(__dirname, `${filePath}/Scripts`, scriptName.split('.')[0] + '.mjs')

    try {
      await fs.access(scriptPath)
      return new Response(Bun.file(scriptPath), {
        headers: {
          'Content-Type': 'text/javascript'
        }
      })
    } catch (error) {
      c.status(404)
      return c.html(renderPage(Pages.getPage('Error'), { 
        error: "console.error('Script Not Found')" 
      }))
    }
  })

  app.get('/Styles/:style', async (c) => {
    const styleName = c.req.param('style')
    const stylePath = path.join(__dirname, `${filePath}/Styles`, styleName)

    try {
      await fs.access(stylePath)
      return new Response(Bun.file(stylePath), {
        headers: {
          'Content-Type': 'text/css'
        }
      })
    } catch (error) {
      c.status(404)
      return c.html(renderPage(Pages.getPage('Error'), { 
        error: 'What style? You mean <a href="/g/228922">this</a>?' 
      }))
    }
  })

  app.get('/Images/:image', async (c) => {
    const imageName = c.req.param('image')
    const imagePath = path.join(__dirname, `${filePath}/Images`, imageName)

    try {
      await fs.access(imagePath)
      const bunFile = Bun.file(imagePath)
      return new Response(bunFile, {
        headers: {
          'Content-Type': bunFile.type
        }
      })
    } catch (error) {
      c.status(404)
      return c.html(renderPage(Pages.getPage('Error'), { 
        error: "The image you're trying find does not exist. You probably have some mental disorders, please contact your doctor for professional help." 
      }))
    }
  })

  app.get('/error', (c) => {
    c.status(404)
    return c.html(renderPage(Pages.getPage('Error'), { 
      error: 'Don\'t tell anyone but I got some <a href="/g/228922">good stuff</a> for you :)' 
    }))
  })

  app.get('/robots.txt', async (c) => {
    const robotsPath = path.join(__dirname, `${filePath}/robots.txt`)
    try {
      await fs.access(robotsPath)
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

  app.notFound((c) => {
    return c.redirect('/error')
  })

  Log.info('Starting nZip Server...')

  Bun.serve({
    port,
    fetch: app.fetch,
    websocket
  })

  Log.success(`nZip running on ${host}/`)
}

/**
 * Get the IP address of the client
 * @param c Context containing request and response information
 * @returns The IP address as a string
 */
export function getIP(c: Context): string {
  try {
    const forwardedFor = c.req.header('X-Forwarded-For')
    return forwardedFor ? forwardedFor.split(',')[0].trim() : getConnInfo(c).remote.address || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Render a page with the provided arguments
 * @param page The page module to render
 * @param args Optional arguments to pass to the page
 * @returns A string containing the rendered HTML of the page
 */
async function renderPage(page: PageModule, args?: null | Record<string, unknown>): Promise<string> {
  try {
    const { Element } = scope
    const Page = page(scope, args)
    const doctype = '<!DOCTYPE html>'
    const head = [
      new Element('title', { innerHTML: Page.title }),
      new Element('meta', { name: 'title', content: Page.title }),
      new Element('meta', { name: 'description', content: Page.description }),
      new Element('meta', { name: 'og:title', content: Page.title }),
      new Element('meta', { name: 'og:description', content: Page.description }),
    ]

    if (Page.keywords) head.push(new Element('meta', { name: 'keywords', content: Page.keywords }))

    head.push(
      new Element('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1.0' }),
      new Element('meta', { charset: 'utf-8' })
    )

    head.push(
      new Element('link', { rel: 'icon', href: '/Images/icon.ico' }),
      new Element('link', { rel: 'stylesheet', href: '/Styles/Main.css' })
    )

    if (analytics) head.push(new Element('script', analytics))

    const html = new Element('html', { lang: 'en' }, [
      new Element('head', {}, head),
      Page.content
    ]).render()

    return doctype + html
  } catch (error) {
    Log.error(error)
    return '<!DOCTYPE html><html><body>Page Not Found</body></html>'
  }
}
