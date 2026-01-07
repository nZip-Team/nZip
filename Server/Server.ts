import Bun from 'bun'
import { Hono, type Context } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { getConnInfo } from 'hono/bun'

import path from 'path'

import nhget, { type GalleryData } from '@icebrick/nhget'
import Log from '@icebrick/log'

import Pages, { type PageName } from './Pages'
import WebSocketHandler from './WebSocket'
import Languages from './Language'

let analytics: string | null = null

let filePath = './App'

/**
 * Start the server
 * @param host Hostname (which will only be used for logging)
 * @param port Port
 * @param apiHost API host
 * @param imageHost Image host
 * @param downloadDir Download directory
 * @param concurrentImageDownloads Number of concurrent image downloads
 * @param analytic Analytics data
 * @param version nZip version
 */
export default (host: string, port: number, apiHost: string, imageHost: string, downloadDir: string, concurrentImageDownloads: number, analytic: string, version: string) => {
  const nh = new nhget({
    endpoint: `${apiHost}/api/gallery/`,
    imageEndpoint: `${imageHost}/galleries/`
  })

  const WSHandler = new WebSocketHandler(nh, imageHost, downloadDir, concurrentImageDownloads)

  analytics = analytic || null

  const app = new Hono()

  app.use(async (c, next) => {
    c.header('X-Powered-By', `nZip ${version}`)
    await next()
    Log.info(`${c.req.method} ${c.req.path} ${c.res.status} - ${getIP(c)}`)
  })

  app.on('GET', ['/', '/home'], (c) => {
    return Page(c, 'Home', { version })
  })

  app.get('/terms', (c) => {
    return Page(c, 'Terms')
  })

  app.get('/privacy', (c) => {
    return Page(c, 'Privacy')
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
      const response: GalleryData = await nh.get(id) as GalleryData

      if (response.error) {
        c.status(404)
        return Page(c, 'Error', {
          error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?'
        })
      } else {
        const type = response.images.pages[0].t
        const extension = type === 'j' ? 'jpg' : type === 'g' ? 'gif' : type === 'w' ? 'webp' : 'png'
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        const cover = `${imageHost}/galleries/${response.media_id}/1.${extension}`
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
    }
  })

  app.on('GET', ['/g/:id/', '/g/:id/:any{.+}'], (c) => {
    const id = c.req.param('id')
    return c.redirect(`/g/${id}`)
  })

  app.get('/ws/g/:id', upgradeWebSocket((c) => {
    return WSHandler.handle(c)
  }))

  app.get('/download/:hash/:file', async (c) => {
    try {
      const hash = c.req.param('hash')
      const fileName = decodeURIComponent(c.req.param('file'))

      const filePath = sanitizePath(hash, downloadDir)
      const fileLoc = sanitizePath(fileName, path.join(downloadDir, hash))

      if (!filePath || !fileLoc) throw true

      if (!fileName.endsWith('.zip')) throw new Error('Invalid File')
      if (!(await Bun.file(fileLoc).exists())) throw new Error('File does not exist')

      const [start, end] = parseRangeHeader(c.req.header('Range'))

      const file = Bun.file(fileLoc)
      return new Response(file.slice(start, end))
    } catch {
      c.status(404)
      return Page(c, 'Error', {
        error: 'That file does not exist. You can go back <a href="/">home</a> and get a new link.'
      })
    }
  })

  app.get('/Scripts/:script', async (c) => {
    try {
      const scriptName = c.req.param('script')
      const scriptPath = sanitizePath(scriptName, `${filePath}/Scripts`)

      if (!scriptPath) throw true

      if (!(await Bun.file(scriptPath).exists())) throw new Error('Script does not exist')
      return new Response(Bun.file(scriptPath), {
        headers: {
          'Content-Type': 'text/javascript'
        }
      })
    } catch {
      c.status(404)
      return Page(c, 'Error', {
        error: "console.error('Script Not Found')"
      })
    }
  })

  app.get('/Styles/:style', async (c) => {
    try {
      const styleName = c.req.param('style')
      const stylePath = sanitizePath(styleName, `${filePath}/Styles`)

      if (!stylePath) throw true

      if (!(await Bun.file(stylePath).exists())) throw new Error('Style does not exist')
      return new Response(Bun.file(stylePath), {
        headers: {
          'Content-Type': 'text/css'
        }
      })
    } catch {
      c.status(404)
      return Page(c, 'Error', {
        error: 'What style? Do you mean <a href="/g/228922">this</a>?'
      })
    }
  })

  app.get('/Images/:image', async (c) => {
    try {
      const imageName = c.req.param('image')
      const imagePath = sanitizePath(imageName, `${filePath}/Images`)

      if (!imagePath) {
        throw new Error()
      }

      if (!(await Bun.file(imagePath).exists())) throw new Error('Image does not exist')
      const bunFile = Bun.file(imagePath)
      return new Response(bunFile, {
        headers: {
          'Content-Type': bunFile.type
        }
      })
    } catch {
      c.status(404)
      return Page(c, 'Error', {
        error: "The image you're trying to find does not exist. You probably have some mental disorders, please contact your doctor for professional help."
      })
    }
  })

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
  const normalized = userInput.replace(/\\/g, '/')

  const basePath = path.isAbsolute(baseDir) ? path.resolve(baseDir) : path.resolve(path.join(process.cwd(), baseDir))
  const fullPath = path.resolve(path.join(basePath, normalized))

  if (!fullPath.startsWith(basePath)) {
    return null
  }

  return fullPath
}

/**
 * Render a page with the provided arguments
 * @param page The page to render
 * @param args Optional arguments to pass to the page
 * @returns A string containing the rendered HTML of the page
 */
async function Page(c: Context, pagename: PageName, args?: null | Record<string, unknown>): Promise<Response> {
  try {
    const lang = Languages.getLanguageFromCookie(c.req.header('Cookie'))
    const Args = {
      ...args,
      t: (key: string) => Languages.translate(lang, pagename, key)
    }

    return c.html(Pages.page(pagename, Args).render({ analytics }))
  } catch (error) {
    Log.error(error)
    return c.html('<!DOCTYPE html><html><body>Page Not Found</body></html>')
  }
}
