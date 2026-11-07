// Custom events for the Umami-compatible tracker that ANALYTICS loads (window.umami). Without it, nothing is sent.
// Do Not Track is the tracker's own business (data-do-not-track); nothing here stores anything.

type Source = 'page' | 'card'

/** The event catalog: names and data keys the analytics dashboard expects. No free text from users. */
export interface TrackEvents {
  download_start: { gallery: number; format: string; source: Source }
  download_ready: { gallery: number; format: string; pages: number; missing: number; seconds: number; source: Source }
  file_download: { gallery: number; format: string; source: Source; auto: 0 | 1 }
  download_error: { gallery: number; format: string; stage: 'connect' | 'download' | 'pack' | 'rate_limited'; source: Source }
  format_change: { gallery: number; from: string; to: string }
  search: { sort: string; page: number; results: number; length: number }
  search_rate_limited: { seconds: number }
  batch_download: { count: number; format: string }
  copy_link: { gallery: number }
  pref_change: { key: 'language' | 'theme' | 'blur' | 'notify'; value: string }
  history_clear: Record<string, never>
  shortcut: { key: string }
  ws_reconnect: { attempt: number }
}

export type TrackValue = string | number
export type TrackData = Record<string, TrackValue>

interface Tracker {
  track: (name: string, data?: TrackData) => unknown
}

declare global {
  interface Window {
    umami?: Tracker
  }
}

// The limits of POST /api/send
const MAX_NAME = 50
const MAX_KEYS = 50
const MAX_KEY = 500
const MAX_STRING = 500

export const WAIT_MS = 10_000
export const POLL_MS = 250
export const MAX_QUEUE = 20
export const DEDUPE_MS = 500

/** Flat string/number data within the limits; anything else is dropped */
export function sanitise(data: unknown): TrackData {
  const clean: TrackData = {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) return clean

  let keys = 0
  for (const [key, value] of Object.entries(data)) {
    if (keys >= MAX_KEYS) break
    let kept: TrackValue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      kept = value
    } else if (typeof value === 'string') {
      kept = value.slice(0, MAX_STRING)
    } else if (typeof value === 'boolean') {
      kept = value ? 1 : 0
    } else {
      continue
    }
    clean[key.slice(0, MAX_KEY)] = kept
    keys++
  }
  return clean
}

export interface TrackOptions {
  tracker: () => Tracker | undefined
  now: () => number
  every: (callback: () => void, ms: number) => () => void
}

/** A track function bound to a tracker lookup and a clock, so the tests can fake both */
export function createTrack(options: TrackOptions): (name: string, data?: unknown) => void {
  const queue: Array<[string, TrackData]> = []
  const recent = new Map<string, number>()
  let stopPolling: (() => void) | null = null
  let deadline = 0
  let gaveUp = false

  const send = (tracker: Tracker, name: string, data: TrackData) => {
    try {
      const result = tracker.track(name, data) as Promise<unknown> | undefined
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      // A broken tracker must never break the page
    }
  }

  const current = (): Tracker | undefined => {
    try {
      const tracker = options.tracker()
      return tracker && typeof tracker.track === 'function' ? tracker : undefined
    } catch {
      return undefined
    }
  }

  const poll = () => {
    const tracker = current()
    if (!tracker && options.now() < deadline) return
    stopPolling?.()
    stopPolling = null
    // Blocked or not configured: stop waiting for good
    if (!tracker) gaveUp = true
    const pending = queue.splice(0)
    if (tracker) for (const [name, data] of pending) send(tracker, name, data)
  }

  return (name, data) => {
    try {
      if (typeof name !== 'string' || !name || /^[=+\-@\t\r]/.test(name)) return
      const event = name.slice(0, MAX_NAME)
      const clean = sanitise(data)

      const now = options.now()
      const key = `${event}\n${JSON.stringify(clean)}`
      const last = recent.get(key)
      if (last !== undefined && now - last < DEDUPE_MS) return
      recent.set(key, now)
      if (recent.size > 100) {
        for (const [old, at] of recent) if (now - at >= DEDUPE_MS) recent.delete(old)
      }

      const tracker = current()
      if (tracker && queue.length === 0) return send(tracker, event, clean)
      if (tracker) {
        queue.push([event, clean])
        return poll()
      }
      if (gaveUp || queue.length >= MAX_QUEUE) return

      queue.push([event, clean])
      if (!stopPolling) {
        deadline = now + WAIT_MS
        stopPolling = options.every(poll, POLL_MS)
      }
    } catch {
      // Analytics never gets in the way
    }
  }
}

const browserTrack = createTrack({
  tracker: () => (typeof window === 'undefined' ? undefined : window.umami),
  now: () => Date.now(),
  every: (callback, ms) => {
    const timer = setInterval(callback, ms)
    return () => clearInterval(timer)
  }
})

/** Send a catalog event; never throws, does nothing without the tracker */
export function track<K extends keyof TrackEvents>(name: K, ...data: TrackEvents[K] extends Record<string, never> ? [] : [TrackEvents[K]]): void {
  browserTrack(name, data[0])
}
