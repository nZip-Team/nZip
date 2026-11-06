import path from 'path'
import { existsSync, watch, type FSWatcher } from 'fs'

import type { ServerWebSocket } from 'bun'

import Log from '../Tools/Log'

export type LiveReloadKind = 'page' | 'script' | 'style' | 'language'

/** Development-only push channel telling the open browser socket what changed. */
class LiveReload {
  private clients = new Set<ServerWebSocket>()
  private styleWatcher: FSWatcher | null = null
  private styleTimer: ReturnType<typeof setTimeout> | null = null

  public add(socket: ServerWebSocket): void {
    this.clients.add(socket)
  }

  public remove(socket: ServerWebSocket): void {
    this.clients.delete(socket)
  }

  /**
   * Tell every connected browser what changed.
   * @param kind What was reloaded on the server
   */
  public broadcast(kind: LiveReloadKind): void {
    if (this.clients.size === 0) return

    const payload = JSON.stringify({ kind })
    let delivered = 0

    for (const socket of Array.from(this.clients)) {
      try {
        socket.send(payload)
        delivered++
      } catch {
        this.clients.delete(socket)
      }
    }

    Log.debug(`Live reload: ${kind} sent to ${delivered} client(s)`)
  }

  /** Watch the stylesheet directory, which has no module of its own to hook. */
  public watchStyles(stylesDir: string): void {
    if (this.styleWatcher || !existsSync(stylesDir)) return

    this.styleWatcher = watch(stylesDir, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.css')) return

      if (this.styleTimer) clearTimeout(this.styleTimer)
      this.styleTimer = setTimeout(() => {
        this.styleTimer = null
        if (!existsSync(path.join(stylesDir, filename))) return

        Log.info(`Style file changed: ${filename}`)
        this.broadcast('style')
      }, 50)
    })

    this.styleWatcher.unref?.()
  }

  public shutdown(): void {
    if (this.styleTimer) {
      clearTimeout(this.styleTimer)
      this.styleTimer = null
    }

    if (this.styleWatcher) {
      this.styleWatcher.close()
      this.styleWatcher = null
    }

    for (const socket of this.clients) {
      try {
        socket.close(1001, 'Server shutting down')
      } catch { /* already gone */ }
    }

    this.clients.clear()
  }
}

/** Dev-only client snippet; a regained socket means the server restarted, so it reloads. */
export const LIVE_RELOAD_CLIENT = `(() => {
  let attempts = 0

  const swapStyles = () => {
    for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
      const next = link.cloneNode()
      const url = new URL(link.href, location.href)
      url.searchParams.set('live', String(Date.now()))
      next.href = url.toString()
      next.addEventListener('load', () => link.remove(), { once: true })
      link.after(next)
    }
  }

  const connect = () => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(protocol + '://' + location.host + '/dev/livereload')

    socket.addEventListener('open', () => {
      if (attempts > 0) location.reload()
      attempts = 0
    })

    socket.addEventListener('message', (event) => {
      let kind = ''
      try { kind = JSON.parse(event.data).kind } catch { return }

      if (kind === 'style') swapStyles()
      else location.reload()
    })

    socket.addEventListener('close', () => {
      attempts++
      setTimeout(connect, Math.min(500 * attempts, 5000))
    })
  }

  connect()
})()`

export default new LiveReload()
