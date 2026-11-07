import { describe, expect, test } from 'bun:test'

import { createTrack, sanitise, DEDUPE_MS, MAX_QUEUE, POLL_MS, WAIT_MS, type TrackData } from '../Server/Scripts/Shared/Track'

/** A fake clock, interval and window.umami */
function harness(withTracker = true) {
  let now = 1_000_000
  const events: Array<[string, TrackData | undefined]> = []
  const intervals = new Set<() => void>()
  let umami: { track: (name: string, data?: TrackData) => unknown } | undefined = withTracker ? { track: (name, data) => events.push([name, data]) } : undefined

  const track = createTrack({
    tracker: () => umami,
    now: () => now,
    every: (callback) => {
      intervals.add(callback)
      return () => intervals.delete(callback)
    }
  })

  return {
    track,
    events,
    intervals,
    load: (tracker: { track: (name: string, data?: TrackData) => unknown } = { track: (name, data) => events.push([name, data]) }) => (umami = tracker),
    advance: (ms: number) => {
      const end = now + ms
      while (now < end) {
        now = Math.min(end, now + POLL_MS)
        for (const callback of Array.from(intervals)) callback()
      }
    }
  }
}

describe('track', () => {
  test('sends straight to the tracker', () => {
    const h = harness()
    h.track('copy_link', { gallery: 228922 })
    expect(h.events).toEqual([['copy_link', { gallery: 228922 }]])
  })

  test('does nothing without a tracker, and gives up after the wait', () => {
    const h = harness(false)
    h.track('copy_link', { gallery: 1 })
    expect(h.intervals.size).toBe(1)
    h.advance(WAIT_MS + POLL_MS)
    expect(h.intervals.size).toBe(0)
    // Loading late changes nothing for what was dropped, and new calls are not queued again
    h.load()
    h.advance(1000)
    expect(h.events).toEqual([])
  })

  test('stops for good once it gave up, even if a tracker appears much later', () => {
    const h = harness(false)
    h.track('shortcut', { key: '/' })
    h.advance(WAIT_MS + POLL_MS)
    h.track('shortcut', { key: 'd' })
    expect(h.intervals.size).toBe(0)
  })

  test('queues calls made before the tracker loaded, in order', () => {
    const h = harness(false)
    h.track('download_start', { gallery: 1, format: 'zip', source: 'page' })
    h.track('copy_link', { gallery: 1 })
    expect(h.events).toEqual([])
    h.advance(1000)
    h.load()
    h.advance(POLL_MS)
    expect(h.events.map(([name]) => name)).toEqual(['download_start', 'copy_link'])
    expect(h.intervals.size).toBe(0)
    h.track('shortcut', { key: 'd' })
    expect(h.events.length).toBe(3)
  })

  test('keeps at most 20 queued events', () => {
    const h = harness(false)
    for (let i = 0; i < MAX_QUEUE + 5; i++) h.track('ws_reconnect', { attempt: i })
    h.load()
    h.advance(POLL_MS)
    expect(h.events.length).toBe(MAX_QUEUE)
    expect(h.events.at(-1)).toEqual(['ws_reconnect', { attempt: MAX_QUEUE - 1 }])
  })

  test('drops an identical event within 500 ms, not a different one or a later one', () => {
    const h = harness()
    h.track('copy_link', { gallery: 1 })
    h.track('copy_link', { gallery: 1 })
    h.track('copy_link', { gallery: 2 })
    h.advance(DEDUPE_MS)
    h.track('copy_link', { gallery: 1 })
    expect(h.events).toEqual([
      ['copy_link', { gallery: 1 }],
      ['copy_link', { gallery: 2 }],
      ['copy_link', { gallery: 1 }]
    ])
  })

  test('never throws, whatever the tracker does', () => {
    const h = harness()
    h.load({
      track: () => {
        throw new Error('blocked')
      }
    })
    expect(() => h.track('history_clear')).not.toThrow()
    h.load({ track: () => Promise.reject(new Error('offline')) })
    expect(() => h.track('history_clear', { a: 1 })).not.toThrow()
    const broken = createTrack({
      tracker: () => {
        throw new Error('getter')
      },
      now: () => 0,
      every: () => {
        throw new Error('timer')
      }
    })
    expect(() => broken('copy_link', { gallery: 1 })).not.toThrow()
  })

  test('rejects names the endpoint refuses and truncates long ones', () => {
    const h = harness()
    for (const name of ['', '=cmd', '+x', '-x', '@x', '\tx', '\rx']) h.track(name)
    h.track('x'.repeat(80))
    expect(h.events).toEqual([['x'.repeat(50), {}]])
  })
})

describe('sanitise', () => {
  test('numbers stay numbers, strings are cut at 500, nothing nested', () => {
    const data = sanitise({ gallery: 228922, seconds: 12.3, format: 'zip', long: 'a'.repeat(600), ok: true, no: false, nested: { a: 1 }, list: [1], nil: null, none: undefined, nan: NaN, inf: Infinity, fn: () => 1 })
    expect(data).toEqual({ gallery: 228922, seconds: 12.3, format: 'zip', long: 'a'.repeat(500), ok: 1, no: 0 })
    expect(typeof data['gallery']).toBe('number')
  })

  test('at most 50 keys, and only plain objects', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(sanitise(many)).length).toBe(50)
    expect(sanitise([1, 2])).toEqual({})
    expect(sanitise('text')).toEqual({})
    expect(sanitise(undefined)).toEqual({})
  })
})
