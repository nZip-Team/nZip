import Server from './Server/Server'
import Scripts from './Server/Modules/Scripts'

const development = process.env['NODE_ENV'] === 'development'

let serverCleanup: (() => Promise<void>) | null = null
let isShuttingDown = false

async function shutdown(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log()
  
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
    await Scripts.bundle()
  }

  serverCleanup = await Server()

  if (development) {
    Scripts.watchSource()
  }
}

start() // Where All Miracles Begin
