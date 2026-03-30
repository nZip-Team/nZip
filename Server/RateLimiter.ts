/**
 * Simple in-memory rate limiter keyed by IP prefix:
 * - IPv4: /24 (first 3 octets)
 * - IPv6: /64 (first 4 hextets)
 */
export default class RateLimiter {
  private maxRequests: number
  private windowMs: number
  private store: Map<string, number[]>

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests
    this.windowMs = windowMs
    this.store = new Map()
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

    // IPv4
    if (ip.includes('.')) {
      const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (!m) return `ipv4:${ip}`
      const a = Number(m[1])
      const b = Number(m[2])
      const c = Number(m[3])
      if ([a, b, c].some((n) => Number.isNaN(n))) return `ipv4:${ip}`
      return `ipv4:${a}.${b}.${c}`
    }

    // IPv6
    try {
      const normalized = ip.replace(/^[\[|\]]+|[\[|\]]+$/g, '')
      const segs = this.expandIPv6(normalized)
      const prefix = segs.slice(0, 4).map((s) => s.toLowerCase()).join(':')
      return `ipv6:${prefix}`
    } catch {
      return `ipv6:${ip}`
    }
  }

  public allow(ip: string): boolean {
    const key = this.getPrefix(ip)
    const now = Date.now()
    const windowStart = now - this.windowMs

    let arr = this.store.get(key) || []
    arr = arr.filter((t) => t > windowStart)

    if (arr.length >= this.maxRequests) {
      this.store.set(key, arr)
      return false
    }

    arr.push(now)
    this.store.set(key, arr)
    return true
  }
}
