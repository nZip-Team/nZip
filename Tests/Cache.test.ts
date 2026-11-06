import './env'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'

import TTLCache from '../Server/Tools/TTLCache'

afterEach(() => {
  setSystemTime()
})

describe('TTLCache', () => {
  test('concurrent misses share one load', async () => {
    const lookups: string[] = []
    const cache = new TTLCache<number>(10, 60000, (result) => lookups.push(result))
    let loads = 0
    const load = async () => {
      loads++
      await Bun.sleep(5)
      return 42
    }

    expect(await Promise.all([cache.get('a', load), cache.get('a', load), cache.get('a', load)])).toEqual([42, 42, 42])
    expect(loads).toBe(1)
    expect(await cache.get('a', load)).toBe(42)
    expect(loads).toBe(1)
    expect(lookups).toEqual(['miss', 'shared', 'shared', 'hit'])
  })

  test('entries expire', async () => {
    setSystemTime(new Date('2026-11-06T00:00:00Z'))
    const cache = new TTLCache<string>(10, 60000)
    let loads = 0
    const load = async () => `v${++loads}`

    expect(await cache.get('k', load)).toBe('v1')
    setSystemTime(new Date('2026-11-06T00:00:59Z'))
    expect(await cache.get('k', load)).toBe('v1')
    setSystemTime(new Date('2026-11-06T00:01:01Z'))
    expect(await cache.get('k', load)).toBe('v2')
  })

  test('failures are not cached', async () => {
    const cache = new TTLCache<string>(10, 60000)
    await expect(cache.get('k', async () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    expect(await cache.get('k', async () => 'up')).toBe('up')
  })

  test('the least recently used entry goes first', async () => {
    const cache = new TTLCache<string>(2, 60000)
    await cache.get('a', async () => 'a')
    await cache.get('b', async () => 'b')
    await cache.get('a', async () => 'a2')
    await cache.get('c', async () => 'c')

    expect(cache.size).toBe(2)
    expect(await cache.get('a', async () => 'reloaded')).toBe('a')
    expect(await cache.get('b', async () => 'reloaded')).toBe('reloaded')
  })
})
