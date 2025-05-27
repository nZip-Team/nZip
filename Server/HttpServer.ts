import express from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs/promises'
import { existsSync, watch } from 'fs'

import nhget, { type GalleryData } from '@icebrick/nhget'
import Log from '@icebrick/log'

import { Scope, type ElementAttributes } from '@lightbery/scope'

import type { RenderScope, Page as PageModule } from './Types'

const PAGE_NAMES = ['Home', 'Download', 'Error', 'Terms', 'Privacy'] as const

type PageName = typeof PAGE_NAMES[number]

const Pages: Record<PageName, PageModule> = {} as Record<PageName, PageModule>
const CachedPages: Record<PageName, PageModule | null> = {} as Record<PageName, PageModule | null>

PAGE_NAMES.forEach(name => {
  Pages[name] = null as unknown as PageModule
  CachedPages[name] = null
})

function loadPages() {
  if (process.env['NODE_ENV'] === 'development') {
    Object.keys(require.cache).forEach(key => {
      if (key.includes('Pages')) {
        delete require.cache[key]
      }
    })
  }

  for (const page of PAGE_NAMES) {
    try {
      const module = require(`../App/Pages/${page}`).default as PageModule
      Pages[page] = module
      CachedPages[page] = module
    } catch (error) {
      Log.error(`Failed to load ${page} page`, error)
      if (CachedPages[page]) {
        Pages[page] = CachedPages[page] as PageModule
        Log.info(`Using cached version of ${page} page`)
      }
    }
  }
}

loadPages()

let analytics: ElementAttributes | null = null

let filePath = './App'
if (existsSync(path.join(__dirname, '../App'))) filePath = '../App'

const scope: RenderScope = new Scope(undefined)

/**
 * Start the HTTP server
 * @param host Hostname (which will only be used for logging)
 * @param port Port
 * @param apiHost API host
 * @param imageHost Image host
 * @param analytic Analytics data
 * @param version nZip version
 */
export default (host: string, port: number, apiHost: string, imageHost: string, analytic: string, version: string): http.Server => {
  analytics = analytic ? (JSON.parse(analytic) as ElementAttributes) : null

  const nh = new nhget({
    endpoint: `${apiHost}/api/gallery/`,
    imageEndpoint: `${imageHost}/galleries/`
  })

  const app = express()
  const server = http.createServer(app)

  if (process.env['NODE_ENV'] === 'development') {
    const pagesDir = path.join(__dirname, '../App/Pages')
    if (existsSync(pagesDir)) {
      watch(pagesDir, (eventType, filename) => {
        if (filename && eventType === 'change') {
          Log.info(`Page file changed: ${filename} - reloading...`)
          try {
            loadPages()
            Log.success('Pages reloaded successfully')
          } catch (error) {
            Log.error('Failed to reload pages:', error)
          }
        }
      })
      Log.info('Hot reloading enabled for page files')
    }
  }

  app.use((req, res, next) => {
    res.setHeader('X-Powered-By', 'nZip')
    res.on('finish', () => {
      logRequest(req, res)
    })
    next()
  })

  app.get(['/', '/home'], async (_, res) => {
    sendPage(res, Pages['Home'], { version })
  })

  app.get('/terms', async (_, res) => {
    sendPage(res, Pages['Terms'])
  })

  app.get('/privacy', async (_, res) => {
    sendPage(res, Pages['Privacy'])
  })

  app.get('/g/:id', async (req, res) => {
    let id = req.params.id
    if (!Number(id)) {
      sendPage(res, Pages['Error'], { error: "That's not a Number 😭" })
      return
    }

    try {
      const response: GalleryData = (await nh.get(id)) as GalleryData

      if (response.error) {
        await sendPage(res, Pages['Error'], { error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?' })
      } else {
        const extension = response.images.pages[0].t === 'j' ? 'jpg' : response.images.pages[0].t === 'g' ? 'gif' : response.images.pages[0].t === 'w' ? 'webp' : 'png'
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        const cover = `${imageHost}/galleries/${response.media_id}/1.${extension}`
        sendPage(res, Pages['Download'], { id, title, cover })
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Not Found') || error.message.includes('does not exist')) {
          await sendPage(res, Pages['Error'], { error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?' })
        } else {
          await sendPage(res, Pages['Error'], { error: 'An error occurred while fetching the gallery.' })
        }
      }
    }
  })

  app.get('/g/:id/*any', (req, res) => {
    res.redirect(`/g/${req.params.id}`)
  })

  app.get('/download/:hash/:file', async (req, res) => {
    const filePath = path.join(__dirname, 'Cache', 'Downloads', req.params.hash, req.params.file)

    try {
      if (!req.params.file.endsWith('.zip')) throw new Error('Invalid File')
      await fs.access(filePath)
      await sendFile(res, filePath)
    } catch {
      await sendPage(res, Pages['Error'], { error: 'That file does not exist. You can go back <a href="/">home</a> and get a new link.' })
    }
  })

  app.get('/Scripts/:script', async (req, res) => {
    const scriptPath = path.join(__dirname, `${filePath}/Scripts`, req.params.script.split('.')[0] + '.mjs')

    try {
      await fs.access(scriptPath)
      await sendFile(res, scriptPath)
    } catch {
      await sendPage(res, Pages['Error'], { error: "console.error('Script Not Found')" })
    }
  })

  app.get('/Styles/:style', async (req, res) => {
    const stylePath = path.join(__dirname, `${filePath}/Styles`, req.params.style)

    try {
      await fs.access(stylePath)
      await sendFile(res, stylePath)
    } catch {
      await sendPage(res, Pages['Error'], { error: 'What style? You mean <a href="/g/228922">this</a>?' })
    }
  })

  app.get('/Images/:image', async (req, res) => {
    const imagePath = path.join(__dirname, `${filePath}/Images`, req.params.image)

    try {
      await fs.access(imagePath)
      await sendFile(res, imagePath)
    } catch {
      await sendPage(res, Pages['Error'], { error: "The image you're trying find does not exist. You probably have some mental disorders, please contact your doctor for professional help." })
    }
  })

  app.get('/error', async (_, res) => {
    sendPage(res, Pages['Error'], { error: 'Don\'t tell anyone but I got some <a href="/g/228922">good stuff</a> for you :)' })
  })

  app.get('/robots.txt', async (_, res) => {
    await sendFile(res, path.join(__dirname, `${filePath}/robots.txt`))
  })

  app.all('*any', (_, res) => {
    res.redirect('/error')
  })

  server.listen(port, () => {
    Log.success(`nZip running on ${host}/`)
  })

  return server
}

/**
 * Sends an HTML page to the client.
 * @param res - The HTTP response object.
 * @param page - The page function to generate the HTML content.
 * @param args - Optional arguments to pass to the page function.
 */
// prettier-ignore
async function sendPage(res: http.ServerResponse, page: PageModule, args?: null | Record<string, unknown>): Promise<void> {
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

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(doctype + html)
  } catch (error) {
    Log.error(error)
    res.end('Page Not Found')
  }
}

/**
 * Sends a file to the client.
 * @param res - The HTTP response object.
 * @param filePath - The path to the file to send.
 */
async function sendFile(res: express.Response, filePath: string): Promise<void> {
  try {
    await fs.access(filePath)
    res.sendFile(filePath)
  } catch {
    res.end('Resource Not Found')
  }
}

/**
 * Logs the request to the console.
 * @param req - The HTTP request object.
 * @param res - The HTTP response object.
 */
function logRequest(req: express.Request, res: express.Response): void {
  Log.info(`${req.method} ${req.url} ${res.statusCode} - ${req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown'}`)
}
