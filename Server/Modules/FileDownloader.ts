import http from 'http'
import https from 'https'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { EventEmitter } from 'events'

import Log from './Log'

/**
 * Download options
 * @param concurrentDownloads Number of concurrent downloads
 * @param maxRetries Maximum number of retries for failed downloads
 * @param downloadDir Directory to save downloaded files
 * @param timeout Request timeout in milliseconds
 * @param debug Enable debug logging
 */
interface DownloadOptions {
  concurrentDownloads?: number
  maxRetries?: number
  downloadDir?: string
  timeout?: number
  debug?: boolean
}

/**
 * Download request
 * @param urls URLs to download
 * @param headers Request headers
 * @param cookies Request cookies
 */
interface DownloadRequest {
  urls: string[]
  headers?: { [key: string]: string }
  cookies?: { [key: string]: string }
}

/**
 * Download task
 * @param url URL to download
 * @param headers Request headers
 * @param cookies Request cookies
 */
interface DownloadTask {
  url: string
  headers?: { [key: string]: string }
  cookies?: { [key: string]: string }
}

export default class FileDownloader extends EventEmitter {
  private concurrentDownloads: number
  private maxRetries: number
  private downloadDir: string
  private redirectLimit: number
  private timeout: number
  private debug: boolean
  private totalTasks: number
  private completedTasks: number
  private active: boolean = false
  private activeRequests: http.ClientRequest[] = []

  /**
   * Create a new FileDownloader instance
   * @param options Downloader options
   * @param options.concurrentDownloads Number of concurrent downloads
   * @param options.maxRetries Maximum number of retries for failed downloads
   * @param options.downloadDir Directory to save downloaded files
   * @param options.timeout Request timeout in milliseconds
   * @param options.debug Enable debug logging
   */
  constructor(options: DownloadOptions = {}) {
    super()
    this.concurrentDownloads = options.concurrentDownloads || 2
    this.maxRetries = options.maxRetries || 3
    this.downloadDir = options.downloadDir || './downloads'
    this.redirectLimit = 5
    this.timeout = options.timeout || 30000
    this.debug = options.debug || false
    this.totalTasks = 0
    this.completedTasks = 0

    fsp.mkdir(this.downloadDir, { recursive: true }).catch((err) => {
      this.log(`Failed to create download directory: ${err.message}`)
    })
  }

  /**
   * Download files from the given URLs
   * @param requests Array of download requests
   */
  async download(requests: DownloadRequest[]): Promise<void> {
    if (this.active) {
      throw new Error('FileDownloader is already running; stop() before calling download() again')
    }
    this.active = true
    const tasks: DownloadTask[] = []

    for (const request of requests) {
      for (const url of request.urls) {
        tasks.push({
          url,
          headers: request.headers,
          cookies: request.cookies
        })
      }
    }

    this.totalTasks = tasks.length
    this.completedTasks = 0

    const workers: Promise<void>[] = []

    for (let i = 0; i < this.concurrentDownloads; i++) {
      workers.push(this.worker(tasks))
    }

    try {
      await Promise.all(workers)
    } catch (error) {
      this.active = false
      throw error
    }
  }

  /**
   * Stop all ongoing downloads
   */
  async stop(): Promise<void> {
    if (!this.active) return

    this.log('Stopping all downloads')
    this.active = false

    for (const req of this.activeRequests) {
      try {
        req.destroy()
      } catch (err) {
        // Ignore errors during cleanup
      }
    }

    this.activeRequests = []
    this.emit('stopped')

    await this.delay(100)
  }

  private async worker(queue: DownloadTask[]): Promise<void> {
    while (queue.length > 0 && this.active) {
      const task = queue.shift()
      if (task) {
        await this.downloadWithRetries(task)
        this.completedTasks++
        this.emit('progress', this.completedTasks, this.totalTasks)
      }
    }
  }

  private async downloadWithRetries(task: DownloadTask): Promise<void> {
    let attempts = 0
    while (attempts < this.maxRetries && this.active) {
      try {
        await this.downloadFile(task)
        return
      } catch (error) {
        if (!this.active) {
          // Downloads stopped, exit immediately
          return
        }

        const errorMessage = error instanceof Error ? error.message : String(error)

        if (errorMessage === 'Downloads stopped') {
          return
        }

        attempts++
        if (attempts >= this.maxRetries) {
          this.log(`Failed to download ${task.url} after ${this.maxRetries} attempts.`)
        } else {
          this.log(`Retrying download for ${task.url}. Attempt ${attempts + 1}.`)
          await this.delay(2 ** attempts * 1000)
        }
      }
    }
  }

  private async downloadFile(task: DownloadTask, redirectCount = 0): Promise<void> {
    if (redirectCount >= this.redirectLimit) {
      throw new Error(`Too many redirects for ${task.url}`)
    }

    if (!this.active) {
      throw new Error('Downloads stopped')
    }

    const { url, headers, cookies } = task
    const protocol = url.startsWith('https') ? https : http
    const fileName = path.basename(new URL(url).pathname)
    const filePath = path.join(this.downloadDir, fileName)

    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true })
    } catch (error) {
      throw new Error(`Failed to prepare download directory for ${fileName}: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      await fsp.access(filePath)
      this.log(`File ${fileName} already exists. Skipping download.`)
      return
    } catch {
      // File doesn't exist, proceed with download
    }

    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        headers: {
          ...headers,
          Cookie: cookies
            ? Object.entries(cookies)
                .map(([k, v]) => `${k}=${v}`)
                .join('; ')
            : ''
        }
      }

      const overallTimeout = setTimeout(() => {
        this.log(`Overall timeout reached for ${url}`)
        req.destroy()
        reject(new Error(`Overall request timeout for ${url}`))
      }, this.timeout)

      const req = protocol.get(url, options, (response) => {
        const { statusCode, headers: resHeaders } = response

        if (!this.active) {
          req.destroy()
          reject(new Error('Downloads stopped'))
          return
        }

        if (statusCode && statusCode >= 200 && statusCode < 300) {
          const fileStream = fs.createWriteStream(filePath)

          const cleanup = async () => {
            clearTimeout(overallTimeout)
            this.activeRequests = this.activeRequests.filter((r) => r !== req)
            try {
              fileStream.close()
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 100))
            try {
              if (fs.existsSync(filePath)) {
                await fsp.unlink(filePath).catch(() => {})
              }
            } catch {}
          }

          response.pipe(fileStream)

          response.on('error', async (err) => {
            await cleanup()
            reject(err)
          })

          fileStream.on('finish', () => {
            clearTimeout(overallTimeout)
            this.activeRequests = this.activeRequests.filter((r) => r !== req)
            this.log(`Downloaded ${url} to ${filePath}`)
            resolve()
          })

          fileStream.on('error', async (err) => {
            await cleanup()
            reject(err)
          })

          if (!this.active) {
            cleanup().then(() => reject(new Error('Downloads stopped')))
          }
        } else if (statusCode && statusCode >= 300 && statusCode < 400 && resHeaders.location) {
          clearTimeout(overallTimeout)
          this.activeRequests = this.activeRequests.filter((r) => r !== req)
          response.resume()
          const redirectUrl = new URL(resHeaders.location, url).toString()
          this.downloadFile({ ...task, url: redirectUrl }, redirectCount + 1)
            .then(resolve)
            .catch(reject)
        } else {
          clearTimeout(overallTimeout)
          this.activeRequests = this.activeRequests.filter((r) => r !== req)
          response.resume()
          reject(new Error(`Failed to get '${url}' (${statusCode})`))
        }
      })

      this.activeRequests.push(req)

      req.on('error', async (err) => {
        clearTimeout(overallTimeout)
        this.activeRequests = this.activeRequests.filter((r) => r !== req)
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (fs.existsSync(filePath)) {
          await fsp.unlink(filePath).catch(() => {})
        }
        reject(err)
      })

      req.on('timeout', () => {
        clearTimeout(overallTimeout)
        this.activeRequests = this.activeRequests.filter((r) => r !== req)
        req.destroy()
        reject(new Error(`Request timed out for ${url}`))
      })

      req.on('close', () => {
        if (!this.active) {
          clearTimeout(overallTimeout)
          this.activeRequests = this.activeRequests.filter((r) => r !== req)
          reject(new Error('Downloads stopped'))
        }
      })
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private log(message: string): void {
    if (this.debug) {
      Log.debug(message)
    }
  }
}

export { FileDownloader }
export type { DownloadOptions, DownloadRequest, DownloadTask }
