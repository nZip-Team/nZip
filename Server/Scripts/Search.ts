// Download buttons on search results, in the format last chosen on the download page

import { getCookie } from './Shared/Cookie'
import { addHistory } from './Shared/History'
import { GallerySocket, galleryWsUrl } from './Shared/Socket'
import { onShortcuts, focusField } from './Shared/Shortcuts'
import { track } from './Shared/Track'

const grid = document.querySelector<HTMLElement>('.search-grid')
const status = document.getElementById('search-status')
const batch = document.getElementById('search-batch') as HTMLButtonElement | null
const formats = ['zip', 'cbz', 'pdf', 'epub']

// The server allows 10 WebSocket upgrades a minute; two at a time stays well inside it
const MAX_CONCURRENT = 2
const RATE_LIMIT_PAUSE_MS = 60_000
const MAX_REFUSALS = 3

function readStrings(): Record<string, string> {
  try {
    const parsed = JSON.parse(grid?.dataset['strings'] || '{}') as unknown
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch {
    // English fallbacks below
  }
  return {}
}

const strings = readStrings()
const s = (key: string, fallback: string) => strings[key] || fallback

// Rendered by App/Pages/Search.tsx: counts and the sort only, never the query text
const shown = grid?.dataset['sort']
if (grid && shown) {
  track('search', { sort: shown, page: Number(grid.dataset['page']) || 1, results: Number(grid.dataset['total']) || 0, length: Number(grid.dataset['length']) || 0 })
}
const retryAfter = Number(grid?.dataset['retryAfter'])
if (retryAfter > 0) track('search_rate_limited', { seconds: retryAfter })

type CardState = 'idle' | 'queued' | 'running' | 'done' | 'warning' | 'error'

const queue: HTMLButtonElement[] = []
const running = new Set<HTMLButtonElement>()
const refusals = new WeakMap<HTMLButtonElement, number>()
let pausedUntil = 0
let batchRunning = false
let pauseTimer: ReturnType<typeof setTimeout> | undefined

function preferredFormat(): string {
  const format = getCookie('file_format') || 'zip'
  return formats.includes(format) ? format : 'zip'
}

function saveFile(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.click()
}

function setCard(button: HTMLButtonElement, state: CardState, text: string, message = ''): void {
  button.dataset['state'] = state
  button.textContent = text
  button.title = message
  button.disabled = state === 'queued' || state === 'running'
  setCardMessage(button, message, state === 'warning' ? 'warning' : 'error')
}

// Visible under the card, so touch users see it too (a title tooltip alone never shows there)
function setCardMessage(button: HTMLButtonElement, message: string, tone: 'warning' | 'error'): void {
  const element = button.closest('.search-card')?.querySelector<HTMLElement>('.search-card-message')
  if (!element) return
  element.textContent = message
  element.dataset['tone'] = tone
}

function updateBatch(): void {
  if (!batch) return
  if (running.size === 0 && queue.length === 0) batchRunning = false
  batch.disabled = batchRunning
  batch.textContent = batchRunning ? s('allRunning', 'Downloading this page…') : s('all', 'Download all on this page')
}

function enqueue(button: HTMLButtonElement, front = false): void {
  if (queue.includes(button) || running.has(button)) return
  if (front) queue.unshift(button)
  else queue.push(button)
  setCard(button, 'queued', s('queued', '…'))
  pump()
}

function pump(): void {
  if (Date.now() >= pausedUntil) {
    while (running.size < MAX_CONCURRENT && queue.length > 0) start(queue.shift()!)
  }
  updateBatch()
}

function pause(): void {
  pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS
  if (status) status.textContent = s('rateLimited', 'Too many downloads at once. Waiting a minute before continuing…')
  clearTimeout(pauseTimer)
  pauseTimer = setTimeout(() => {
    pausedUntil = 0
    if (status) status.textContent = ''
    pump()
  }, RATE_LIMIT_PAUSE_MS)
}

/** The 0x02 frame: JSON with count/total/missing */
function missingCount(payload: string): number {
  try {
    const warning = JSON.parse(payload) as { count?: unknown; missing?: unknown }
    if (typeof warning.count === 'number') return warning.count
    if (Array.isArray(warning.missing)) return warning.missing.length
  } catch {
    // Count unknown
  }
  return 0
}

function start(button: HTMLButtonElement): void {
  const id = button.dataset['id']!
  const title = button.dataset['title'] || id
  const format = preferredFormat()
  const label = format.toUpperCase()
  const gallery = Number(id)
  const started = Date.now()
  let pages = Number(button.dataset['pages']) || 0
  let missing = 0
  let stage: 'connect' | 'download' | 'pack' = 'connect'
  let link = ''
  let warning = ''
  let finished = false

  // A retry after a refused upgrade continues the same download
  if (!refusals.has(button)) track('download_start', { gallery, format, source: 'card' })

  running.add(button)
  setCard(button, 'running', '…')

  const show = (text: string) => {
    button.textContent = warning ? `⚠ ${text}` : text
  }

  const end = (state: CardState, text: string, message = '') => {
    if (finished) return
    finished = true
    session.stop()
    running.delete(button)
    setCard(button, state, text, message)
    pump()
  }

  const succeed = (url: string) => {
    track('download_ready', { gallery, format, pages, missing, seconds: Math.round((Date.now() - started) / 100) / 10, source: 'card' })
    saveFile(url)
    // The card click asked for it
    track('file_download', { gallery, format, source: 'card', auto: 0 })
    addHistory({ id, title, format })
    refusals.delete(button)
    end(warning ? 'warning' : 'done', warning ? `⚠ ${label}` : label, warning)
  }

  const fail = (message: string) => {
    if (!finished) track('download_error', { gallery, format, stage, source: 'card' })
    end('error', '!', message || s('failed', 'Download failed, click to try again'))
  }

  let prepared = false
  const session = new GallerySocket(galleryWsUrl(id), {
    open: () => {
      // A reconnect (e.g. a rolling restart) replays the link, and the new connection must ask for the format again
      prepared = false
      session.send({ type: 'start' })
    },

    message: (data) => {
      if (typeof data === 'string') {
        let message: { type?: string; status?: string; error?: string }
        try {
          message = JSON.parse(data)
        } catch {
          return
        }
        if (message.type !== 'prepare') return
        if (message.status === 'ready') succeed(link.replace(/\.zip$/i, `.${format}`))
        else if (message.status === 'error') fail(message.error || '')
        return
      }

      const bytes = new Uint8Array(data)
      const text = () => new TextDecoder().decode(bytes.slice(1)).trim()

      if (bytes[0] === 0x00 && bytes.length >= 5) {
        const view = new DataView(bytes.buffer)
        stage = 'download'
        if (!button.dataset['pages']) pages = view.getUint16(3)
        show(`${view.getUint16(1)}/${view.getUint16(3)}`)
      } else if (bytes[0] === 0x02) {
        const count = missingCount(text())
        missing = count
        warning = s('missing', '{count} pages missing').replace('{count}', count ? String(count) : '?')
        setCardMessage(button, warning, 'warning')
      } else if (bytes[0] === 0x10) {
        stage = 'pack'
        show(s('packing', '…'))
      } else if (bytes[0] === 0x01 || bytes[0] === 0x11) {
        stage = bytes[0] === 0x01 ? 'download' : 'pack'
        fail(text())
      } else if (bytes[0] === 0x20 && !prepared) {
        prepared = true
        stage = 'pack'
        link = text()
        if (format === 'zip') {
          succeed(link)
        } else {
          show(s('packing', '…'))
          try {
            session.send({ type: 'prepare', format })
          } catch {
            fail('')
          }
        }
      }
    },

    closed: ({ opened }) => {
      if (finished) return
      if (opened) return fail('')

      // Never opened: the upgrade was refused, almost always the per-minute limit. Wait it out, then carry on.
      finished = true
      running.delete(button)
      const count = (refusals.get(button) ?? 0) + 1
      refusals.set(button, count)

      if (count < MAX_REFUSALS) {
        pause()
        enqueue(button, true)
      } else {
        refusals.delete(button)
        track('download_error', { gallery, format, stage: 'rate_limited', source: 'card' })
        setCard(button, 'error', '!', s('busy', 'Server busy or rate limited. Try again later.'))
        pump()
      }
    }
  })

  session.start()
}

grid?.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.search-card-download')
  if (button && !button.disabled) enqueue(button)
})

const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.search-card-download'))
buttons.forEach((button) => {
  button.textContent = preferredFormat().toUpperCase()
  button.dataset['state'] = 'idle'
})

if (batch && buttons.length > 0) {
  batch.hidden = false
  batch.addEventListener('click', () => {
    batchRunning = true
    // Everything not already fetched in this visit
    const pending = buttons.filter((button) => button.dataset['state'] === 'idle' || button.dataset['state'] === 'error')
    track('batch_download', { count: pending.length, format: preferredFormat() })
    pending.forEach((button) => enqueue(button))
  })
}

function followLink(rel: 'prev' | 'next'): boolean {
  const link = document.querySelector<HTMLAnchorElement>(`.pagination a[rel="${rel}"]`)
  if (!link) return false
  link.click()
  return true
}

onShortcuts({
  '/': () => focusField(document.querySelector<HTMLInputElement>('input[name="q"]')),
  ArrowLeft: () => followLink('prev'),
  ArrowRight: () => followLink('next')
})
