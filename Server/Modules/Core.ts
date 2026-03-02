/**
 * IPC bridge between the Bun server and the nzip Go core process.
 */

import path from 'path'
import fs from 'fs'
import { spawn, type ChildProcess } from 'node:child_process'
import Log from './Log'
import Config from '../../Config'

export interface DownloadConfig {
  hash: string
  images: string[]
  filename: string
  downloadDir: string
  concurrentDownloads: number
  debug?: boolean
  onProgress: (completed: number, total: number) => void
  onPackStart: () => void
  isAborting: () => boolean
}

export type DownloadResult =
  | { success: true }
  | { success: false; errorCode: 0x01 | 0x11 }

export interface IDownloadManager {
  run(config: DownloadConfig): Promise<DownloadResult>
  stopDownload(hash: string): Promise<void>
  hasActiveDownload(hash: string): boolean
  stopAll(): void
  cleanTempFiles(downloadDir: string, filename: string): void
}

export interface SharedSessionData {
  id: string
  hash: string
  downloadCompleted: boolean
  isDownloading: boolean
  downloadingBy?: string
  filename?: string
  downloadLink?: string
  lastDownloadStatus?: string
  lastPackStatus?: string
  lastLinkStatus?: string
  isAborting: boolean
  createdAt: number
  lastActivityAt: number
}

export interface ISessionStore {
  getOrCreate(id: string, hash: string): Promise<SharedSessionData>
  get(hash: string): SharedSessionData | null | Promise<SharedSessionData | null>
  update(hash: string, data: Partial<SharedSessionData>): Promise<void>
  touch(hash: string): Promise<void>
  delete(hash: string): Promise<void>
  exists(hash: string): Promise<boolean>
  tryAcquireLock(hash: string, processID: string): Promise<boolean>
  refreshLock(hash: string, processID: string): Promise<boolean>
  releaseLock(hash: string, processID: string): Promise<void>
  close(): Promise<void>
  getAll(): SharedSessionData[] | Promise<SharedSessionData[]>
}

interface GoCommand {
  reqId: string
  cmd: string
  [key: string]: unknown
}

interface GoResponse {
  reqId: string
  type: 'result' | 'progress' | 'packStart'
  ok?: boolean
  error?: string
  errorCode?: number
  data?: unknown
  value?: unknown
  completed?: number
  total?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: (completed: number, total: number) => void
  onPackStart?: () => void
}

export class Core {
  private coreDir: string
  private dbPath: string
  private binaryPath: string
  private proc: ChildProcess | null = null
  private procStdin: NodeJS.WritableStream | null = null
  private stdoutBuffer = ''
  private handledTransportClose = new WeakSet<ChildProcess>()
  private pending = new Map<string, PendingRequest>()
  private reqCounter = 0
  private intentionalClose = false
  private suppressRestart = false
  private restarting = false

  readonly sessionStore: ISessionStore
  readonly downloadManager: CoreDownloadManager

  constructor(binaryPath?: string) {
    const cwd = process.cwd()
    const inCwd = (candidate: string): boolean => {
      const resolved = path.resolve(candidate)
      return resolved === cwd || resolved.startsWith(`${cwd}${path.sep}`)
    }

    const coreDirCandidates = [
      process.env['CORE_DIR'],
      path.join(cwd, 'Core')
    ].filter((candidate): candidate is string => !!candidate && inCwd(candidate))

    this.coreDir = coreDirCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'go.mod'))) ?? path.join(cwd, 'Core')

    this.dbPath = path.join(
      cwd,
      fs.existsSync(path.join(cwd, 'Server')) ? 'Server' : '',
      'Cache',
      'sessions.db'
    )

    const binaryCandidates = [
      binaryPath,
      process.env['CORE_BINARY_PATH'],
      path.join(cwd, 'nzip-core'),
      path.join(cwd, 'Core', 'nzip-core')
    ].filter((candidate): candidate is string => !!candidate && inCwd(candidate))

    this.binaryPath = binaryCandidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(this.coreDir, 'nzip-core')

    this.sessionStore = new CoreSessionStore(this)
    this.downloadManager = new CoreDownloadManager(this)
  }

  private shouldUseGoRun(): boolean {
    if (process.env['NODE_ENV'] !== 'development') return false
    if (!fs.existsSync(this.coreDir)) return false
    return fs.existsSync(path.join(this.coreDir, 'go.mod'))
  }

  /** Spawn the Go process and start the read loop. */
  async start(): Promise<void> {
    if (this.proc && this.proc.exitCode === null) return

    this.intentionalClose = false
    const useGoRun = this.shouldUseGoRun()
    if (!useGoRun && !fs.existsSync(this.binaryPath)) {
      throw new Error(`Core: binary not found at ${this.binaryPath}`)
    }

    const proc = useGoRun
      ? spawn('go', ['run', '.'], {
          cwd: this.coreDir,
          stdio: ['pipe', 'pipe', 'inherit'],
          env: {
            ...process.env,
            DB_PATH: this.dbPath,
            NZIP_VERSION: Config.version,
          },
        })
      : spawn(this.binaryPath, [], {
          stdio: ['pipe', 'pipe', 'inherit'],
          env: {
            ...process.env,
            DB_PATH: this.dbPath,
            NZIP_VERSION: Config.version,
          },
        })

    if (useGoRun) {
      Log.info('Core: starting via go run . (development mode)')
    }

    this.proc = proc
    this.procStdin = proc.stdin
    this.stdoutBuffer = ''

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string | Buffer) => {
      this.handleStdoutChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })

    proc.stdout.on('close', () => {
      void this.handleTransportClose(proc, 'stdout closed')
    })

    proc.on('exit', (code, signal) => {
      Log.debug(`Core: process exited (code=${code} signal=${signal})`)
      void this.handleTransportClose(proc, `process exited (code=${code} signal=${signal})`)
    })

    proc.on('error', (err) => {
      Log.error(`Core: process error: ${err}`)
      void this.handleTransportClose(proc, 'process error')
    })

    // Give the process a moment to start up.
    await this.delay(100)
    Log.info('Core: process started')
  }

  /** Mark backend as entering shutdown to prevent auto-restart races. */
  prepareForShutdown(): void {
    this.suppressRestart = true
  }

  /** Send a shutdown command and wait for the process to exit. */
  async close(): Promise<void> {
    this.suppressRestart = true
    this.intentionalClose = true
    try {
      await this.call({ cmd: 'shutdown' })
    } catch {
      // ignore - process may already be exiting
    }
    const proc = this.proc
    if (proc) {
      await this.waitForExit(proc, 1000)
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
      this.proc = null
      this.procStdin = null
    }
    // Reject pending requests.
    for (const [, pending] of this.pending) {
      pending.reject(new Error('Core: closed'))
    }
    this.pending.clear()
  }

  nextReqId(): string {
    return `r${++this.reqCounter}`
  }

  /**
   * Send a command and return a promise that resolves/rejects on the
   * final "result" message.  Does NOT support progress notifications;
   * use `callStreaming` for download.start.
   */
  call<T = unknown>(cmdFields: Omit<GoCommand, 'reqId'>): Promise<T> {
    return this.callStreaming<T>(cmdFields)
  }

  /**
   * Send a command and return a promise.  Optionally accepts callbacks for
   * streaming "progress" / "packStart" messages.
   */
  callStreaming<T = unknown>(
    cmdFields: Omit<GoCommand, 'reqId'>,
    opts?: { onProgress?: PendingRequest['onProgress']; onPackStart?: PendingRequest['onPackStart'] },
    retryCount = 0
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const reqId = this.nextReqId()
      this.pending.set(reqId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress: opts?.onProgress,
        onPackStart: opts?.onPackStart,
      })
      try {
        this.sendRaw({ reqId, ...cmdFields } as GoCommand)
      } catch (err) {
        this.pending.delete(reqId)

        if (this.shouldRetrySendError(err) && retryCount < 5 && !this.intentionalClose && !this.suppressRestart) {
          if (this.isBrokenPipeError(err)) {
            void this.restartProcess('broken pipe on write')
          }
          setTimeout(() => {
            this.callStreaming<T>(cmdFields, opts, retryCount + 1).then(resolve).catch(reject)
          }, 100 * (retryCount + 1))
          return
        }

        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private sendRaw(cmd: GoCommand): void {
    if (!this.proc || !this.procStdin) {
      if (this.restarting) throw new Error('Core: restarting')
      throw new Error(this.intentionalClose || this.suppressRestart ? 'Core: closed' : 'Core: not started')
    }
    const line = JSON.stringify(cmd) + '\n'
    Log.debug(`Core ->  [${cmd.reqId}] ${cmd.cmd}`)
    try {
      this.procStdin.write(line)
    } catch (err) {
      if (this.isBrokenPipeError(err)) {
        void this.restartProcess('broken pipe')
      }
      throw err
    }
  }

  private isBrokenPipeError(err: unknown): boolean {
    if (!err) return false
    const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
    return msg.includes('EPIPE') || msg.toLowerCase().includes('broken pipe')
  }

  private shouldRetrySendError(err: unknown): boolean {
    if (!err) return false
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    return this.restarting || this.isBrokenPipeError(err) || msg.includes('not started') || msg.includes('restarting')
  }

  private async restartProcess(reason: string): Promise<void> {
    if (this.restarting || this.suppressRestart || this.intentionalClose) return
    this.restarting = true

    const proc = this.proc
    this.proc = null
    this.procStdin = null

    for (const [, pending] of this.pending) {
      pending.reject(new Error(`Core: process unavailable (${reason})`))
    }
    this.pending.clear()

    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore
      }
      await this.waitForExit(proc, 500)
    }

    if (!this.suppressRestart && !this.intentionalClose) {
      try {
        await this.start()
        Log.info('Core: process restarted successfully')
      } catch (err) {
        Log.error(`Core: failed to restart process: ${err}`)
      }
    }

    this.restarting = false
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const resp: GoResponse = JSON.parse(trimmed)
        this.handleResponse(resp)
      } catch (err) {
        Log.warn(`Core: failed to parse response: ${trimmed} - ${err}`)
      }
    }
  }

  private async handleTransportClose(proc: ChildProcess, reason: string): Promise<void> {
    if (this.handledTransportClose.has(proc)) return
    this.handledTransportClose.add(proc)

    if (this.intentionalClose || this.suppressRestart) {
      Log.debug(`Core: ${reason} (intentional shutdown)`)
      if (this.proc === proc) {
        this.proc = null
        this.procStdin = null
      }
      return
    }

    Log.warn(`Core: ${reason} - restarting`)
    if (this.proc === proc) {
      this.proc = null
      this.procStdin = null
    }
    await this.restartProcess(reason)
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null) return
    await Promise.race([
      new Promise<void>((resolve) => proc.once('exit', () => resolve())),
      this.delay(timeoutMs),
    ])
  }

  private handleResponse(resp: GoResponse): void {
    const pending = this.pending.get(resp.reqId)
    if (!pending) {
      Log.debug(`Core <-  [${resp.reqId}] orphaned ${resp.type} (no pending request)`)
      return
    }

    if (resp.type === 'progress') {
      Log.debug(`Core <-  [${resp.reqId}] progress ${resp.completed}/${resp.total}`)
      pending.onProgress?.(resp.completed ?? 0, resp.total ?? 0)
      return
    }

    if (resp.type === 'packStart') {
      Log.debug(`Core <-  [${resp.reqId}] packStart`)
      pending.onPackStart?.()
      return
    }

    // type === 'result'
    this.pending.delete(resp.reqId)

    if (!resp.ok) {
      if (resp.errorCode !== undefined) {
        Log.debug(`Core <-  [${resp.reqId}] result error code=0x${resp.errorCode.toString(16)}`)
        // Download error - resolve with a typed failure object rather than reject.
        pending.resolve({ success: false, errorCode: resp.errorCode })
      } else {
        Log.debug(`Core <-  [${resp.reqId}] result error: ${resp.error}`)
        pending.reject(new Error(resp.error ?? 'Core: unknown error'))
      }
      return
    }

    Log.debug(`Core <-  [${resp.reqId}] result ok`)
    // Scalar value (bool) or object data.
    pending.resolve(resp.value !== undefined ? resp.value : resp.data ?? null)
  }
}

class CoreSessionStore implements ISessionStore {
  constructor(private backend: Core) {}

  async getOrCreate(id: string, hash: string): Promise<SharedSessionData> {
    return this.backend.call<SharedSessionData>({ cmd: 'session.getOrCreate', hash, galleryId: id })
  }

  async get(hash: string): Promise<SharedSessionData | null> {
    return this.backend.call<SharedSessionData | null>({ cmd: 'session.get', hash })
  }

  async update(hash: string, data: Partial<SharedSessionData>): Promise<void> {
    // Serialize through JSON to strip undefined fields before sending.
    const clean = JSON.parse(JSON.stringify(data))
    await this.backend.call({ cmd: 'session.update', hash, data: clean })
  }

  async touch(hash: string): Promise<void> {
    await this.backend.call({ cmd: 'session.touch', hash })
  }

  async delete(hash: string): Promise<void> {
    await this.backend.call({ cmd: 'session.delete', hash })
  }

  async exists(hash: string): Promise<boolean> {
    return this.backend.call<boolean>({ cmd: 'session.exists', hash })
  }

  async getAll(): Promise<SharedSessionData[]> {
    const result = await this.backend.call<SharedSessionData[] | null>({ cmd: 'session.getAll' })
    return result ?? []
  }

  async tryAcquireLock(hash: string, processID: string): Promise<boolean> {
    return this.backend.call<boolean>({ cmd: 'session.tryAcquireLock', hash, processId: processID })
  }

  async refreshLock(hash: string, processID: string): Promise<boolean> {
    return this.backend.call<boolean>({ cmd: 'session.refreshLock', hash, processId: processID })
  }

  async releaseLock(hash: string, processID: string): Promise<void> {
    await this.backend.call({ cmd: 'session.releaseLock', hash, processId: processID })
  }

  async close(): Promise<void> {
    // Backend shutdown is handled by Core.close()
  }
}

/**
 * Drop-in replacement for the TypeScript DownloadManager that delegates
 * all work to the Go backend process.
 *
 * Active download hashes are tracked locally so that hasActiveDownload()
 * can remain synchronous, matching the original DownloadManager interface.
 */
export class CoreDownloadManager implements IDownloadManager {
  /** Hashes of currently-running download.start requests. */
  private active = new Set<string>()

  constructor(private backend: Core) {}

  async run(config: DownloadConfig): Promise<DownloadResult> {
    Log.debug(`Core: download.start ${config.hash} (${config.images.length} images, concurrency=${config.concurrentDownloads})`)
    this.active.add(config.hash)

    // Poll config.isAborting() and forward abort signals to Go.
    let abortSent = false
    const pollInterval = setInterval(() => {
      if (!abortSent && config.isAborting()) {
        abortSent = true
        clearInterval(pollInterval)
        Log.debug(`Core: abort signal forwarded for ${config.hash}`)
        this.stopDownload(config.hash).catch(() => {})
      }
    }, 200)

    try {
      const result = await this.backend.callStreaming<DownloadResult>(
        {
          cmd: 'download.start',
          hash: config.hash,
          images: config.images,
          downloadDir: config.downloadDir,
          filename: config.filename,
          concurrentDownloads: config.concurrentDownloads,
          debug: config.debug ?? false,
        },
        {
          onProgress: config.onProgress,
          onPackStart: config.onPackStart,
        }
      )
      Log.debug(`Core: download.start finished ${config.hash} success=${result.success}`)
      return result
    } finally {
      clearInterval(pollInterval)
      this.active.delete(config.hash)
    }
  }

  async stopDownload(hash: string): Promise<void> {
    await this.backend.call({ cmd: 'download.stop', hash })
  }

  /** Synchronous check backed by local tracking of in-flight run() calls. */
  hasActiveDownload(hash: string): boolean {
    return this.active.has(hash)
  }

  stopAll(): void {
    this.backend.call({ cmd: 'download.stopAll' }).catch(() => {})
  }

  cleanTempFiles(downloadDir: string, filename: string): void {
    this.backend
      .call({ cmd: 'download.cleanTempFiles', downloadDir, filename })
      .catch((err) => Log.warn(`Core: cleanTempFiles error: ${err}`))
  }
}
