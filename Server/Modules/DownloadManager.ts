import { ZipFile } from 'yazl'
import path from 'path'
import fs from 'fs'

import FileDownloader from './FileDownloader'
import Log from './Log'

/**
 * Configuration for a single download + pack operation
 * @param hash Unique identifier for this download (used to track active downloaders)
 * @param images Ordered list of image URLs to download
 * @param filename Target zip filename (written inside downloadDir)
 * @param downloadDir Directory in which images and the final zip are stored
 * @param concurrentDownloads Maximum number of concurrent image downloads
 * @param debug Enable verbose FileDownloader logging
 * @param onProgress Called on every download progress tick
 * @param onPackStart Called once the download phase finishes and packing begins
 * @param isAborting Polled frequently; returning true cancels the current operation
 */
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

/**
 * Common interface shared by DownloadManager and CoreDownloadManager.
 */
export interface IDownloadManager {
  run(config: DownloadConfig): Promise<DownloadResult>
  stopDownload(hash: string): Promise<void>
  hasActiveDownload(hash: string): boolean
  stopAll(): void
  cleanTempFiles(downloadDir: string, filename: string): void
}

/**
 * Manages the two-phase process of downloading gallery images and archiving
 * them into a zip file. Tracks in-flight FileDownloader instances so they
 * can be cleanly stopped from outside (e.g. on abort or server shutdown).
 */
export default class DownloadManager implements IDownloadManager {
  private activeDownloads = new Map<string, FileDownloader>()

  /**
   * Execute a single download + pack attempt.
   * Returns immediately if `isAborting()` becomes true during either phase.
   * @param config Download configuration
   * @returns Result indicating success or the error code that should be sent to clients
   */
  async run(config: DownloadConfig): Promise<DownloadResult> {
    const downloadResult = await this.downloadFiles(config)
    if (!downloadResult.success) {
      return downloadResult
    }

    if (config.isAborting()) {
      return { success: false, errorCode: 0x01 }
    }

    return this.packFiles(config)
  }

  /**
   * Abort and discard the active FileDownloader for the given hash, if any.
   * @param hash Session hash
   */
  async stopDownload(hash: string): Promise<void> {
    const downloader = this.activeDownloads.get(hash)
    if (downloader) {
      await downloader.stop()
      this.activeDownloads.delete(hash)
    }
  }

  /**
   * Returns true when a FileDownloader is actively running for the given hash.
   * This is false during the pack phase or when idle.
   * @param hash Session hash
   */
  hasActiveDownload(hash: string): boolean {
    return this.activeDownloads.has(hash)
  }

  /**
   * Stop every active download and clear the tracking map.
   * Intended for graceful server shutdown.
   */
  stopAll(): void {
    for (const [hash, downloader] of this.activeDownloads.entries()) {
      try {
        downloader.stop()
        Log.info(`Stopped active download: ${hash}`)
      } catch (error) {
        Log.warn(`Error stopping download ${hash}: ${error}`)
      }
    }
    this.activeDownloads.clear()
  }

  /**
   * Remove all files in `downloadDir` except the finished zip archive.
   * Call this after a successful pack to free temporary image files.
   * @param downloadDir Directory containing the downloaded files
   * @param filename Filename of the zip archive to keep
   */
  cleanTempFiles(downloadDir: string, filename: string): void {
    try {
      fs.readdirSync(downloadDir).forEach((file) => {
        if (file !== filename) {
          try {
            fs.unlinkSync(path.join(downloadDir, file))
          } catch (error) {
            Log.warn(`Failed to delete temporary file ${file}: ${error}`)
          }
        }
      })
    } catch (error) {
      Log.warn(`Failed to enumerate download directory ${downloadDir}: ${error}`)
    }
  }

  private async downloadFiles(config: DownloadConfig): Promise<DownloadResult> {
    const { hash, images, downloadDir, concurrentDownloads, debug, onProgress, isAborting } = config

    const downloader = new FileDownloader({
      concurrentDownloads: Math.min(images.length, concurrentDownloads),
      maxRetries: 10,
      downloadDir,
      timeout: 5000,
      debug
    })

    this.activeDownloads.set(hash, downloader)

    let isStopped = false

    const stopDownloads = () => {
      if (isStopped) return
      isStopped = true
      downloader.stop().catch((err) => {
        Log.warn(`Failed to stop downloader for ${hash}: ${err}`)
      })
    }

    const progressHandler = (completed: number, total: number) => {
      if (isAborting()) {
        stopDownloads()
        return
      }
      onProgress(completed, total)
    }

    downloader.on('progress', progressHandler)

    try {
      await downloader.download([{ urls: images }])
    } catch (error) {
      Log.error(`Downloader error for ${hash}: ${error}`)
      return { success: false, errorCode: 0x01 }
    } finally {
      downloader.removeListener('progress', progressHandler)
      this.activeDownloads.delete(hash)
    }

    if (isStopped || isAborting()) {
      return { success: false, errorCode: 0x01 }
    }

    return { success: true }
  }

  private packFiles(config: DownloadConfig): Promise<DownloadResult> {
    return new Promise((resolve) => {
      const { hash, images, filename, downloadDir, onPackStart, isAborting } = config

      let resolved = false
      const done = (result: DownloadResult) => {
        if (!resolved) {
          resolved = true
          resolve(result)
        }
      }

      try {
        const zipFilePath = path.join(downloadDir, filename)

        if (!fs.existsSync(downloadDir)) {
          done({ success: false, errorCode: 0x11 })
          return
        }

        const existingFiles: string[] = []
        for (const url of images) {
          const filePath = path.join(downloadDir, path.basename(url))
          if (fs.existsSync(filePath)) {
            existingFiles.push(filePath)
          }
        }

        if (existingFiles.length === 0) {
          done({ success: false, errorCode: 0x11 })
          return
        }

        onPackStart()

        const zipfile = new ZipFile()
        const output = fs.createWriteStream(zipFilePath)

        output.once('error', (err) => {
          Log.error(`Error writing zip file for ${hash}: ${err}`)
          zipfile.outputStream.unpipe(output)
          output.destroy()
          try {
            if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath)
          } catch {}
          done({ success: false, errorCode: 0x11 })
        })

        zipfile.outputStream.pipe(output).once('close', () => {
          done({ success: true })
        })

        for (const filePath of existingFiles) {
          if (isAborting()) {
            Log.info(`Aborting zip creation for ${hash}`)
            zipfile.end()
            done({ success: false, errorCode: 0x11 })
            return
          }

          if (fs.existsSync(filePath)) {
            try {
              const stats = fs.statSync(filePath)
              if (stats.size > 0) {
                zipfile.addFile(filePath, path.basename(filePath))
              } else {
                Log.warn(`Skipping empty file for ${hash}: ${path.basename(filePath)}`)
              }
            } catch (err) {
              Log.error(`Error adding file to zip for ${hash}: ${err}`)
            }
          } else {
            Log.warn(`File no longer exists for ${hash}, skipping: ${path.basename(filePath)}`)
          }
        }

        zipfile.end()
      } catch (err) {
        Log.error(`Error creating zip for ${hash}: ${err}`)
        done({ success: false, errorCode: 0x11 })
      }
    })
  }
}
