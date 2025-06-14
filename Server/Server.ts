import Bun, { type ServerWebSocket } from 'bun'
import { Hono, type Context } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { getConnInfo } from 'hono/bun'

import { existsSync } from 'fs'
import path from 'path'

import { Scope, type ElementAttributes } from '@lightbery/scope'
import nhget, { type GalleryData } from '@icebrick/nhget'
import Log from '@icebrick/log'

import Pages, { type PageName } from './Pages'
import WebSocketHandler from './WebSocket'
import type { RenderScope } from './Types'

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
    c.header('X-Powered-By', `nZip ${version}`)
    await next()
    Log.info(`${c.req.method} ${c.req.path} ${c.res.status} - ${getIP(c)}`)
  })

  app.on('GET', ['/', '/home'], (c) => {
    return c.html(renderPage('Home', { version }))
  })

  app.get('/terms', (c) => {
    return c.html(renderPage('Terms'))
  })

  app.get('/privacy', (c) => {
    return c.html(renderPage('Privacy'))
  })

  app.get('/g/:id', async (c) => {
    let id = c.req.param('id')
    if (!id || !Number(id)) {
      c.status(400)
      return c.html(renderPage('Error', {
        error: "That's not a Number 😭"
      }))
    }

    try {
      const response: GalleryData = (await nh.get(id)) as GalleryData

      if (response.error) {
        c.status(404)
        return c.html(renderPage('Error', {
          error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?'
        }))
      } else {
        const type = response.images.pages[0].t
        const extension = type === 'j' ? 'jpg' : type === 'g' ? 'gif' : type === 'w' ? 'webp' : 'png'
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        const cover = `${imageHost}/galleries/${response.media_id}/1.${extension}`
        return c.html(renderPage('Download', { id, title, cover }))
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Not Found') || error.message.includes('does not exist')) {
          c.status(404)
          return c.html(renderPage('Error', {
            error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?'
          }))
        } else {
          c.status(500)
          return c.html(renderPage('Error', {
            error: 'Something went wrong while fetching the doujinshi, please try again later or go back to <a href="/">home</a>.'
          }))
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
    try {
      const hash = c.req.param('hash')
      const fileName = c.req.param('file')

      const filePath = sanitizePath(hash, 'Cache/Downloads')
      const fileLoc = sanitizePath(fileName, `Cache/Downloads/${hash}`)

      if (!filePath || !fileLoc) throw true

      if (!fileName.endsWith('.zip')) throw new Error('Invalid File')
      if (!await Bun.file(fileLoc).exists()) throw new Error('File does not exist')

      const [ start, end ] = parseRangeHeader(c.req.header('Range'))

      const file = Bun.file(fileLoc)
      return new Response(file.slice(start, end))
    } catch {
      c.status(404)
      return c.html(renderPage('Error', {
        error: 'That file does not exist. You can go back <a href="/">home</a> and get a new link.'
      }))
    }
  })

  app.get('/Scripts/:script', async (c) => {
    try {
      const scriptName = c.req.param('script')
      const scriptPath = sanitizePath(scriptName, `${filePath}/Scripts`)

      if (!scriptPath) throw true

      if (!await Bun.file(scriptPath).exists()) throw new Error('Script does not exist')
      return new Response(Bun.file(scriptPath), {
        headers: {
          'Content-Type': 'text/javascript'
        }
      })
    } catch {
      c.status(404)
      return c.html(renderPage('Error', { 
        error: "console.error('Script Not Found')" 
      }))
    }
  })

  app.get('/Styles/:style', async (c) => {
    try {
      const styleName = c.req.param('style')
      const stylePath = sanitizePath(styleName, `${filePath}/Styles`)

      if (!stylePath) throw true

      if (!await Bun.file(stylePath).exists()) throw new Error('Style does not exist')
      return new Response(Bun.file(stylePath), {
        headers: {
          'Content-Type': 'text/css'
        }
      })
    } catch {
      c.status(404)
      return c.html(renderPage('Error', { 
        error: 'What style? Do you mean <a href="/g/228922">this</a>?' 
      }))
    }
  })

  app.get('/Images/:image', async (c) => {
    try {
      const imageName = c.req.param('image')
      const imagePath = sanitizePath(imageName, `${filePath}/Images`)

      if (!imagePath) {
        throw new Error()
      }

      if (!await Bun.file(imagePath).exists()) throw new Error('Image does not exist')
      const bunFile = Bun.file(imagePath)
      return new Response(bunFile, {
        headers: {
          'Content-Type': bunFile.type
        }
      })
    } catch {
      c.status(404)
      return c.html(renderPage('Error', { 
        error: "The image you're trying to find does not exist. You probably have some mental disorders, please contact your doctor for professional help." 
      }))
    }
  })

  app.get('/error', (c) => {
    c.status(404)
    return c.html(renderPage('Error', { 
      error: 'Don\'t tell anyone but I got some <a href="/g/228922">good stuff</a> for you :)' 
    }))
  })

  app.get('/favicon.ico', async (c) => {
    return c.redirect('/Images/icon.ico')
  })

  app.get('/robots.txt', async (c) => {
    const robotsPath = path.join(__dirname, `${filePath}/robots.txt`)
    try {
      if (!await Bun.file(robotsPath).exists()) throw new Error('robots.txt does not exist')
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

  app.get('/:epic{^wp.+}', (_c) => {
    return textResponse('Consider fucking off, this isn\'t WordPress. Who the hell uses WordPress in this year?')
  })

  app.get('/:epic{.+\.php}', (_c) => {
    return textResponse('PHP? What is this, 2005? Please use modern technologies such as Node.js or Bun instead :)')
  })

  app.get('/.env', (_c) => {
    return textResponse('XAI_API_KEY=xyzFUCKOFF7890abcdef123456\nOPENAI_API_KEY=sk-YOUSUCK1234567890nonsense\nGITHUB_API_TOKEN=ghp_GETREKT0987654321haha\nAWS_ACCESS_KEY=AKIAYOULOSER1234567890\nAWS_SECRET_KEY=3210YOUREDONE987654321xyz\nNODE_ENV=production', 50)
  })

  app.notFound(async (c) => {
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
    const startNum = startStr ? parseInt(startStr) : 0
    const endNum = endStr ? parseInt(endStr) : Infinity
    
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
  const sanitized = userInput.replace(/\.\./g, '').replace(/\\/g, '/')
  
  const fullPath = path.resolve(path.join(__dirname, baseDir, sanitized))
  const basePath = path.resolve(path.join(__dirname, baseDir))
  
  if (!fullPath.startsWith(basePath)) {
    return null
  }
  
  return fullPath
}

/**
 * Convert a text to a ReadableStream
 * @param text The text to convert
 * @returns A ReadableStream containing the text
 */
function textResponse(text: string, delay: number = 100): Response {
  try {
    const stream = new ReadableStream({
      start(controller) {
        let index = 0
        let isClosed = false
        
        const interval = setInterval(() => {
          if (isClosed) {
            clearInterval(interval)
            return
          }
          
          if (index < text.length) {
            try {
              controller.enqueue(new TextEncoder().encode(text[index]))
              index++
            } catch {
              isClosed = true
              clearInterval(interval)
            }
          } else {
            isClosed = true
            clearInterval(interval)
            try {
              controller.close()
            } catch {}
          }
        }, delay)
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache'
      }
    })
  } catch {
    return new Response('Internal Server Error')
  }
}

/**
 * Render a page with the provided arguments
 * @param page The page to render
 * @param args Optional arguments to pass to the page
 * @returns A string containing the rendered HTML of the page
 */
async function renderPage(page: PageName, args?: null | Record<string, unknown>): Promise<string> {
  try {
    const { Element } = scope
    const Page = Pages.getPage(page)(scope, args)
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
