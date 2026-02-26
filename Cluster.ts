import { spawn, type ChildProcess } from "child_process"
import { existsSync } from "fs"
import os from "os"

import bundle from "./Server/Bundle"
import Log from "./Server/Modules/Log"

await bundle()

const mainFile = existsSync("./Main.js") ? "./Main.js" : "./Main.ts"

const cpus = (process.argv[2] && parseInt(process.argv[2])) || os.cpus().length || 2
const buns: ChildProcess[] = new Array(cpus)
let isShuttingDown = false

function spawnWorker(i: number): void {
  const worker = spawn("bun", [mainFile], {
    stdio: "inherit",
    env: {
      ...process.env,
      SKIP_BUNDLE: "true",
      CLUSTER_ID: String(i),
      CLUSTER_COUNT: String(cpus)
    }
  })
  buns[i] = worker

  worker.once('exit', (code, signal) => {
    if (isShuttingDown) return
    Log.warn(`Worker ${i} exited (code=${code}, signal=${signal}), restarting...`)
    setTimeout(() => {
      if (!isShuttingDown) spawnWorker(i)
    }, 1000)
  })
}

for (let i = 0; i < cpus; i++) {
  spawnWorker(i)
}

async function shutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  Log.info(`\nReceived ${signal}, shutting down cluster gracefully...`)

  const killPromises = buns.map((bun, i) => {
    return new Promise<void>((resolve) => {
      if (bun.killed) {
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        Log.warn(`Force killing worker ${i}...`)
        bun.kill('SIGKILL')
        resolve()
      }, 10000)

      bun.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      bun.kill('SIGTERM')
    })
  })

  await Promise.all(killPromises)
  Log.success('All workers stopped')
  process.exit(0)
}

process.on("SIGTERM", () => shutdown('SIGTERM'))
process.on("SIGINT", () => shutdown('SIGINT'))
process.on("SIGHUP", () => shutdown('SIGHUP'))
