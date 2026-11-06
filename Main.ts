import Server from './Server/Server'
import Scripts from './Server/Modules/Scripts'
import Log from './Server/Tools/Log'

const development = process.env['NODE_ENV'] === 'development'

let serverCleanup: (() => Promise<void>) | null = null
let isShuttingDown = false

// One failed promise must not take down every download of this instance
process.on('unhandledRejection', (reason) => {
  Log.error('Unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
})
process.on('uncaughtException', (error) => {
  Log.error('Uncaught exception:', error.stack ?? error.message)
})

async function shutdown(): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true
  console.log()

  try {
    if (serverCleanup) {
      await serverCleanup()
    }
  } catch (error) {
    Log.error(`Shutdown failed: ${error}`)
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

start().catch((error) => {
  Log.error('Failed to start:', error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
}) // Where All Miracles Begin
