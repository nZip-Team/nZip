import express from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'

import nhget, { type GalleryData } from '@icebrick/nhget'
import Log from '@icebrick/log'

import { Scope, type ElementAttributes } from '@lightbery/scope'

import type { RenderScope, Page } from './Types'

import HomePage from '../App/Pages/Home'
import DownloadPage from '../App/Pages/Download'
import ErrorPage from '../App/Pages/Error'
import TermsPage from '../App/Pages/Terms'
import PrivacyPage from '../App/Pages/Privacy'

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

  app.use((req, res, next) => {
    res.setHeader('X-Powered-By', 'nZip')
    res.on('finish', () => {
      logRequest(req, res)
    })
    next()
  })

  app.get(['/', '/home'], async (_, res) => {
    sendPage(res, HomePage, { version })
  })

  app.get('/terms', async (_, res) => {
    sendPage(res, TermsPage)
  })

  app.get('/privacy', async (_, res) => {
    sendPage(res, PrivacyPage)
  })

  app.get('/g/:id', async (req, res) => {
    let id = req.params.id
    if (!Number(id)) {
      sendPage(res, ErrorPage, { error: "That's not a Number 😭" })
      return
    }

    try {
      const response: GalleryData = (await nh.get(id)) as GalleryData

      if (response.error) {
        await sendPage(res, ErrorPage, { error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?' })
      } else {
        const extension = response.images.pages[0].t === 'j' ? 'jpg' : response.images.pages[0].t === 'g' ? 'gif' : response.images.pages[0].t === 'w' ? 'webp' : 'png'
        const title = response.title.english || response.title.japanese || response.title.pretty || null
        const cover = `${imageHost}/galleries/${response.media_id}/1.${extension}`
        sendPage(res, DownloadPage, { id, title, cover })
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Not Found') || error.message.includes('does not exist')) {
          await sendPage(res, ErrorPage, { error: 'We cannot find this doujinshi, maybe try going back to <a href="/">home</a> and try another one?' })
        } else {
          await sendPage(res, ErrorPage, { error: 'An error occurred while fetching the gallery.' })
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
      await sendPage(res, ErrorPage, { error: 'That file does not exist. You can go back <a href="/">home</a> and get a new link.' })
    }
  })

  app.get('/Scripts/:script', async (req, res) => {
    const scriptPath = path.join(__dirname, `${filePath}/Scripts`, req.params.script.split('.')[0] + '.mjs')

    try {
      await fs.access(scriptPath)
      await sendFile(res, scriptPath)
    } catch {
      await sendPage(res, ErrorPage, { error: "console.error('Script Not Found')" })
    }
  })

  app.get('/Styles/:style', async (req, res) => {
    const stylePath = path.join(__dirname, `${filePath}/Styles`, req.params.style)

    try {
      await fs.access(stylePath)
      await sendFile(res, stylePath)
    } catch {
      await sendPage(res, ErrorPage, { error: 'What style? You mean <a href="/g/228922">this</a>?' })
    }
  })

  app.get('/Images/:image', async (req, res) => {
    const imagePath = path.join(__dirname, `${filePath}/Images`, req.params.image)

    try {
      await fs.access(imagePath)
      await sendFile(res, imagePath)
    } catch {
      await sendPage(res, ErrorPage, { error: "The image you're trying find does not exist. You probably have some mental disorders, please contact your doctor for professional help." })
    }
  })

  app.get('/error', async (_, res) => {
    sendPage(res, ErrorPage, { error: 'Don\'t tell anyone but I got some <a href="/g/228922">good stuff</a> for you :)' })
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
async function sendPage(res: http.ServerResponse, page: Page, args?: null | { [key: string]: any }): Promise<void> {
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
