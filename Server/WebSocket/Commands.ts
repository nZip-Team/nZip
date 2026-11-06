export type ArchiveFormat = 'zip' | 'cbz' | 'pdf' | 'epub'

export type ClientCommand = { type: 'start' } | { type: 'prepare'; format: ArchiveFormat }

const FORMATS: readonly ArchiveFormat[] = ['zip', 'cbz', 'pdf', 'epub']

/** Text of a WebSocket message, whatever form Bun hands it over in */
export function decodeMessage(rawData: unknown): string {
  if (typeof rawData === 'string') return rawData
  if (rawData instanceof ArrayBuffer || rawData instanceof SharedArrayBuffer) return Buffer.from(rawData).toString('utf8')
  if (Buffer.isBuffer(rawData)) return rawData.toString('utf8')
  if (ArrayBuffer.isView(rawData)) return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString('utf8')
  return String(rawData ?? '')
}

export function parseClientCommand(data: string): ClientCommand | null {
  try {
    const parsed = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null

    if (parsed.type === 'start') return { type: 'start' }

    if (parsed.type === 'prepare' && FORMATS.includes(parsed.format)) {
      return { type: 'prepare', format: parsed.format as ArchiveFormat }
    }
  } catch {
    return null
  }

  return null
}

/**
 * Token bucket for the messages of one socket. A page sends "start" once and
 * "prepare" when the format changes; a loop sending more is cut off.
 */
export class MessageLimiter {
  private tokens: number
  private lastRefill: number

  constructor(
    private capacity = 10,
    private refillMs = 1000,
    now: number = Date.now()
  ) {
    this.tokens = capacity
    this.lastRefill = now
  }

  allow(now: number = Date.now()): boolean {
    const earned = Math.floor((now - this.lastRefill) / this.refillMs)
    if (earned > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + earned)
      this.lastRefill += earned * this.refillMs
    }
    if (this.tokens < 1) return false
    this.tokens--
    return true
  }
}
