import './env'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'

import RateLimiter from '../Server/Tools/RateLimiter'
import { MessageLimiter } from '../Server/WebSocket/Commands'

afterEach(() => {
  setSystemTime()
})

describe('RateLimiter', () => {
  test('allows the burst, then refuses until a token refills', () => {
    setSystemTime(new Date('2026-11-06T00:00:00Z'))
    const limiter = new RateLimiter(3, 60000)
    expect([limiter.allow('1.2.3.4'), limiter.allow('1.2.3.4'), limiter.allow('1.2.3.4')]).toEqual([true, true, true])
    expect(limiter.allow('1.2.3.4')).toBe(false)
    expect(limiter.getRetryAfterSeconds('1.2.3.4')).toBe(20)

    setSystemTime(new Date('2026-11-06T00:00:20Z'))
    expect(limiter.allow('1.2.3.4')).toBe(true)
    expect(limiter.allow('1.2.3.4')).toBe(false)
  })

  test('IPv4 clients share a /24 bucket, IPv6 clients a /64', () => {
    const limiter = new RateLimiter(1, 60000)
    expect(limiter.allow('10.0.0.1')).toBe(true)
    expect(limiter.allow('10.0.0.2')).toBe(false)
    expect(limiter.allow('10.0.1.1')).toBe(true)

    expect(limiter.allow('2001:db8:1:2::1')).toBe(true)
    expect(limiter.allow('2001:db8:1:2:ffff::9')).toBe(false)
    expect(limiter.allow('2001:db8:1:3::1')).toBe(true)
  })

  test('no wait for a client it has not seen', () => {
    expect(new RateLimiter(1, 1000).getRetryAfterMs('9.9.9.9')).toBe(0)
  })
})

describe('MessageLimiter', () => {
  test('a burst, then one message per refill interval', () => {
    const limiter = new MessageLimiter(3, 1000, 0)
    expect([limiter.allow(0), limiter.allow(0), limiter.allow(0), limiter.allow(0)]).toEqual([true, true, true, false])
    expect(limiter.allow(999)).toBe(false)
    expect(limiter.allow(1000)).toBe(true)
    expect(limiter.allow(1000)).toBe(false)
    expect(limiter.allow(10000)).toBe(true)
  })
})
