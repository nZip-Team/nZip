import fs from 'fs'
import path from 'path'

import Server from './Server/Server'
import bundle from './Server/Bundle'

import { version } from './package.json'

const httpHost = process.env['HOST'] || 'http://localhost'
const httpPort = parseInt(process.env['PORT'] || '3000')
const apiHost =
  process.env['API_URL'] ??
  (() => {
    throw new Error('API_URL is not defined')
  })()
const imageHost =
  process.env['IMAGE_URL'] ??
  (() => {
    throw new Error('IMAGE_URL is not defined')
  })()
const concurrentImageDownloads = parseInt(process.env['CONCURRENT_IMAGE_DOWNLOADS'] || '16')
const analytics = process.env['ANALYTICS'] || ''
const development = process.env.NODE_ENV === 'development'

const downloadDir = path.join(process.cwd(), fs.existsSync(path.join(process.cwd(), 'Server')) ? 'Server' : '', 'Cache', 'Downloads')
fs.rmSync(downloadDir, { recursive: true, force: true })
fs.mkdirSync(downloadDir, { recursive: true })

async function start(): Promise<void> {
  await bundle()

  Server(httpHost, httpPort, apiHost, imageHost, downloadDir, concurrentImageDownloads, analytics, version)

  if (development) {
    if (!fs.existsSync(path.join(process.cwd(), 'Server', 'Scripts'))) return
    let bundleTimeout: NodeJS.Timeout | null = null

    fs.watch(path.join(process.cwd(), 'Server', 'Scripts'), { recursive: true }, () => {
      if (bundleTimeout) {
        clearTimeout(bundleTimeout)
      }
      bundleTimeout = setTimeout(() => {
        bundle().catch(console.error)
      }, 3000)
    })
  }
}

start() // Where All Miracles Begin
