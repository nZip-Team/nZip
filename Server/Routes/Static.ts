import type { Hono } from 'hono'

import Config from '../../Config'

import { Page, type AppContext, type AppEnv } from '../Render'
import { sanitizePath } from '../Tools/Paths'

const IMMUTABLE = 'public, max-age=31536000, immutable'
// Image names carry no hash, so a changed image has to show up within a day
const IMAGES = 'public, max-age=86400'
const REVALIDATE = 'no-cache'

const versions = new Map<string, { modified: number; version: string }>()

/** The ?v= the pages put on a stylesheet: a hash of its contents */
async function fileVersion(fullPath: string, file: ReturnType<typeof Bun.file>): Promise<string> {
  const cached = versions.get(fullPath)
  if (cached && cached.modified === file.lastModified) return cached.version
  const version = Bun.hash(await file.arrayBuffer()).toString(36)
  versions.set(fullPath, { modified: file.lastModified, version })
  return version
}

export default function registerStatic(app: Hono<AppEnv>, deps: { appDir: string }): void {
  // Bundled as [name]-[hash].js, so a name always means the same contents
  app.get('/Scripts/:script', (c) =>
    serve(c, deps.appDir, c.req.param('script'), 'Scripts', 'text/javascript', async () => (Config.development ? REVALIDATE : IMMUTABLE), {
      error: "console.error('Script Not Found')"
    })
  )

  app.get('/Styles/:style', (c) =>
    serve(
      c,
      deps.appDir,
      c.req.param('style'),
      'Styles',
      'text/css',
      // Immutable only for this replica's version: during a rolling update the other one may get the new URL first
      async (fullPath, file) => (!Config.development && c.req.query('v') === (await fileVersion(fullPath, file)) ? IMMUTABLE : REVALIDATE),
      { error: 'What style? Do you mean <a href="/g/228922">this</a>?' }
    )
  )

  app.get('/Images/:image', (c) =>
    serve(c, deps.appDir, c.req.param('image'), 'Images', 'auto', async () => IMAGES, {
      error: "The image you're trying to find does not exist. You probably have some mental disorders, please contact your doctor for professional help."
    })
  )
}

/**
 * Serve a static file from a directory
 * @param c Context containing request and response information
 * @param appDir The App directory
 * @param fileName The requested file name
 * @param dir The directory to serve files from
 * @param contentType The content type of the file, or 'auto'
 * @param cacheControl Picks the Cache-Control header of a found file
 * @param errorPage The error page data to use if the file is not found
 * @returns A Response object containing the file or an error page
 */
async function serve(c: AppContext, appDir: string, fileName: string | undefined, dir: string, contentType: string, cacheControl: (fullPath: string, file: ReturnType<typeof Bun.file>) => Promise<string>, errorPage: Record<string, unknown>): Promise<Response> {
  const fullPath = fileName ? sanitizePath(fileName, `${appDir}/${dir}`) : null
  const file = fullPath ? Bun.file(fullPath) : null

  if (!fullPath || !file || !(await file.exists())) {
    c.status(404)
    c.header('Cache-Control', 'no-store')
    return Page(c, 'Error', errorPage)
  }

  return new Response(file, {
    headers: {
      'Content-Type': contentType === 'auto' ? file.type : contentType,
      'Cache-Control': await cacheControl(fullPath, file)
    }
  })
}
