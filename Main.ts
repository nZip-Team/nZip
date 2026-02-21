import fs from 'fs'
import path from 'path'

import Server from './Server/Server'
import bundle from './Server/Bundle'

const development = process.env['NODE_ENV'] === 'development'

let serverCleanup: (() => Promise<void>) | null = null
let watcherTimeout: NodeJS.Timeout | null = null
let watcher: fs.FSWatcher | null = null
let isShuttingDown = false

async function shutdown(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log()

  if (watcherTimeout) {
    clearTimeout(watcherTimeout)
    watcherTimeout = null
  }
  
  if (watcher) {
    watcher.close()
    watcher = null
  }
  
  if (serverCleanup) {
    await serverCleanup()
  }
  
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

async function start(): Promise<void> {
  if (!process.env['SKIP_BUNDLE']) {
    await bundle()
  }

  serverCleanup = Server()

  if (development) {
    if (!fs.existsSync(path.join(process.cwd(), 'Server', 'Scripts'))) return

    watcher = fs.watch(path.join(process.cwd(), 'Server', 'Scripts'), { recursive: true }, () => {
      if (watcherTimeout) {
        clearTimeout(watcherTimeout)
      }
      watcherTimeout = setTimeout(() => {
        bundle().catch(console.error)
      }, 3000)
    })
  }
}

start() // Where All Miracles Begin
