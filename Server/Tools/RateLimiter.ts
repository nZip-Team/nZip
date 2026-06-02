interface Bucket {
  tokens: number
  lastRefill: number
}

export default class RateLimiter {
  private maxRequests: number
  private refillIntervalMs: number
  private store: Map<string, Bucket>
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests
    this.refillIntervalMs = maxRequests > 0 ? windowMs / maxRequests : windowMs
    this.store = new Map()

    this.cleanupTimer = setInterval(() => this.cleanup(), windowMs)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  private refill(bucket: Bucket): void {
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    const earned = Math.floor(elapsed / this.refillIntervalMs)

    if (earned > 0) {
      bucket.tokens = Math.min(this.maxRequests, bucket.tokens + earned)
      bucket.lastRefill += earned * this.refillIntervalMs
    }
  }

  public allow(ip: string): boolean {
    const key = this.getPrefix(ip)

    let bucket = this.store.get(key)
    if (!bucket) {
      bucket = { tokens: this.maxRequests, lastRefill: Date.now() }
      this.store.set(key, bucket)
    }

    this.refill(bucket)

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return true
    }

    return false
  }

  public getRetryAfterMs(ip: string): number {
    const key = this.getPrefix(ip)

    const bucket = this.store.get(key)
    if (!bucket) return 0

    this.refill(bucket)

    if (bucket.tokens >= 1) return 0

    const now = Date.now()
    const msUntilNextToken = this.refillIntervalMs - (now - bucket.lastRefill)
    return Math.max(0, msUntilNextToken)
  }

  public getRetryAfterSeconds(ip: string): number {
    return Math.max(0, Math.ceil(this.getRetryAfterMs(ip) / 1000))
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, bucket] of this.store) {
      const elapsed = now - bucket.lastRefill
      const wouldEarn = Math.floor(elapsed / this.refillIntervalMs)
      if (bucket.tokens + wouldEarn >= this.maxRequests) {
        this.store.delete(key)
      }
    }
  }

  public destroy(): void {
    clearInterval(this.cleanupTimer)
    this.store.clear()
  }

  private stripZone(ip: string): string {
    const idx = ip.indexOf('%')
    if (idx !== -1) return ip.slice(0, idx)
    return ip
  }

  private expandIPv6(ip: string): string[] {
    const parts = ip.split('::')
    if (parts.length === 1) {
      return ip.split(':').map((p) => p || '0').map((h) => h.padStart(1, '0'))
    }

    const left = parts[0] ? parts[0].split(':').filter(Boolean) : []
    const right = parts[1] ? parts[1].split(':').filter(Boolean) : []
    const missing = 8 - (left.length + right.length)
    const zeros = new Array(Math.max(0, missing)).fill('0')
    return [...left, ...zeros, ...right]
  }

  private getPrefix(ipRaw: string): string {
    const ip = this.stripZone(ipRaw).trim()
    if (!ip) return 'unknown'

    if (ip.includes('.')) {
      const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (!m) return `ipv4:${ip}`
      const a = Number(m[1])
      const b = Number(m[2])
      const c = Number(m[3])
      if ([a, b, c].some((n) => Number.isNaN(n))) return `ipv4:${ip}`
      return `ipv4:${a}.${b}.${c}`
    }

    try {
      const normalized = ip.replace(/^[\[|\]]+|[\[|\]]+$/g, '')
      const segs = this.expandIPv6(normalized)
      const prefix = segs.slice(0, 4).map((s) => s.toLowerCase()).join(':')
      return `ipv6:${prefix}`
    } catch {
      return `ipv6:${ip}`
    }
  }
}
