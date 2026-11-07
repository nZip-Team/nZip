// The gallery WebSocket with reconnects, shared by the download page and the search result buttons

import { track } from './Track'

export function galleryWsUrl(id: string, search = ''): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/g/${id}${search}`
}

export interface GallerySocketHandlers {
  /** reconnected is true when an earlier connection of this session had opened */
  open: (reconnected: boolean) => void
  message: (data: string | ArrayBuffer) => void
  reconnecting?: (attempt: number) => void
  /** No more connections. opened is false when none ever opened: a refused upgrade, usually the rate limit */
  closed: (info: { opened: boolean; code: number }) => void
}

// The server rejects with 1008 (policy) and 1011 (error); trying again would get the same answer
const FINAL_CODES = [1008, 1011]

/**
 * Reconnects only a connection that had opened. A refused upgrade (a 429 shows up as 1006) is
 * reported at once, since retrying it would spend more of the per-minute WebSocket limit.
 */
export class GallerySocket {
  private socket: WebSocket | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = false
  public opened = false

  constructor(
    private readonly url: string,
    private readonly handlers: GallerySocketHandlers,
    private readonly maxAttempts = 10
  ) {}

  public start(): void {
    this.stopped = false
    this.connect()
  }

  /** Close for good; no handler runs after this */
  public stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.socket?.close()
    this.socket = null
  }

  public get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  public send(command: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Connection is not open')
    this.socket.send(JSON.stringify(command))
  }

  private connect(): void {
    const socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    // A replaced or stopped socket's late events must not reach the handlers
    const stale = () => this.stopped || this.socket !== socket

    socket.addEventListener('open', () => {
      if (stale()) return
      const reconnected = this.opened
      const attempt = this.attempts
      this.opened = true
      this.attempts = 0
      if (reconnected) track('ws_reconnect', { attempt })
      this.handlers.open(reconnected)
    })

    socket.addEventListener('message', (event) => {
      if (stale()) return
      this.handlers.message(event.data as string | ArrayBuffer)
    })

    socket.addEventListener('close', (event) => {
      if (stale()) return

      if (this.opened && !FINAL_CODES.includes(event.code) && this.attempts < this.maxAttempts) {
        const delay = Math.min(1000 * 2 ** this.attempts, 5000)
        this.attempts++
        this.handlers.reconnecting?.(this.attempts)
        this.timer = setTimeout(() => {
          this.timer = null
          if (!this.stopped) this.connect()
        }, delay)
        return
      }

      this.socket = null
      this.handlers.closed({ opened: this.opened, code: event.code })
    })
  }
}
