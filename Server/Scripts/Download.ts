import { getCookie, setCookie } from './Shared/Cookie'
import { addHistory } from './Shared/History'
import { GallerySocket, galleryWsUrl } from './Shared/Socket'
import { onShortcuts } from './Shared/Shortcuts'
import { track } from './Shared/Track'

type States = 'loading' | 'success' | 'error'

function readI18nData(): Record<string, string> {
  try {
    const parsed = JSON.parse(document.getElementById('i18n-data')?.textContent || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // Fall back to the English keys
  }
  return {}
}

const i18n = readI18nData()

// The keys are the English texts, so a missing entry still reads correctly
function t(key: string, fallback = key): string {
  return i18n[key] || fallback
}

function tFormat(key: string, format: string): string {
  return t(key).replace(/\{format\}/g, format.toUpperCase())
}

function formatElapsedTime(startTime: number): string {
  const elapsedSeconds = (Date.now() - startTime) / 1000

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds.toFixed(2)} ${t('sec')}`
  }

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = Math.floor(elapsedSeconds % 60)
  return `${minutes} ${t('min')} ${seconds} ${t('sec')}`
}

function statusAnimation(Container: HTMLElement, Status: HTMLElement, state: States): void {
  if (state === 'loading') {
    Container.style.opacity = '1'
    Status.style.animation = '1s flashing infinite'
    Status.style.backgroundColor = 'var(--text_color)'
  } else if (state === 'success') {
    Container.style.opacity = '1'
    Status.style.animation = ''
    Status.style.backgroundColor = 'var(--text_color)'
  } else if (state === 'error') {
    Container.style.opacity = '1'
    Status.style.animation = ''
    Status.style.borderColor = 'var(--error_color)'
    Status.style.backgroundColor = 'var(--error_color)'
  }
}

const page_main = document.querySelector('main') as HTMLElement
const image_cover = document.getElementById('image-cover') as HTMLImageElement
const cover_toggle = document.getElementById('cover-toggle') as HTMLButtonElement
const copy_link = document.getElementById('copy-link') as HTMLButtonElement
const step_connect_container = document.getElementById('step-connect-container') as HTMLElement
const step_connect_status = document.getElementById('step-connect-status') as HTMLElement
const step_download_container = document.getElementById('step-download-container') as HTMLElement
const step_download_status = document.getElementById('step-download-status') as HTMLElement
const step_pack_container = document.getElementById('step-pack-container') as HTMLElement
const step_pack_status = document.getElementById('step-pack-status') as HTMLElement
const step_pack_text = document.getElementById('step-pack-text') as HTMLElement
const step_finish_container = document.getElementById('step-finish-container') as HTMLElement
const step_finish_status = document.getElementById('step-finish-status') as HTMLElement
const step_finish_text = document.getElementById('step-finish-text') as HTMLElement
const progress_text = document.getElementById('progress-text') as HTMLElement
const progress_format = document.getElementById('progress-format') as HTMLSelectElement
const progress_result = document.getElementById('progress-result') as HTMLAnchorElement
const progress_track = document.getElementById('progress-bar-track') as HTMLElement
const progress_bar = document.getElementById('progress-bar') as HTMLDivElement
const progress_warning = document.getElementById('progress-warning') as HTMLElement
const retry_button = document.getElementById('retry-button') as HTMLButtonElement

const galleryId = page_main.dataset['id'] || window.location.pathname.replace(/^\/g\//, '').replace(/\/.*$/, '')
const galleryTitle = page_main.dataset['title'] || galleryId
const gallery = Number(galleryId)
const galleryPages = Number(page_main.dataset['pages']) || 0
const wsUrl = galleryWsUrl(galleryId, window.location.search)
const baseTitle = document.title

// Dropped connections are retried (a restarting server closes with 1012); server-reported errors and refused upgrades are not
const RECONNECT_MAX_ATTEMPTS = 20
let session: GallerySocket

let hasReceivedAnyMessage = false
let hasTerminalState = false
let step_download: boolean = false
let step_pack: boolean = false
let startTime = 0
let downloadBaseUrl = ''
let completedText = ''
let isPreparingArchive = false
let archiveWorkflowRunning = false
let archiveWorkflowQueued = false
let autoDownloadRequested = false
// 1 while the pending download is the automatic one after finishing, 0 once asked for by a click
let autoDownloadIsAuto: 0 | 1 = 0
// Analytics for this run: when it started, the page count seen, pages left out, formats already reported ready
let flowStart = 0
let progressTotal = 0
let missingPages = 0
let readyReported = new Set<string>()
const validFormats = ['zip', 'cbz', 'pdf', 'epub'] as const
const onDemandFormats = ['cbz', 'pdf', 'epub'] as const
let pendingPrepare: { format: string; resolve: () => void; reject: (error: Error) => void; onStarted: () => void } | null = null
const defaultFinishText = step_finish_text.textContent || 'Finish!'

// A reload or a back/forward visit already downloaded once; then the finished archive is only offered
const navigationType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type
let autoDownload = navigationType !== 'reload' && navigationType !== 'back_forward'

function isValidFormat(format: string | null): format is (typeof validFormats)[number] {
  return format !== null && validFormats.includes(format as (typeof validFormats)[number])
}

function isOnDemandFormat(format: string): format is (typeof onDemandFormats)[number] {
  return onDemandFormats.includes(format as (typeof onDemandFormats)[number])
}

function replaceArchiveExtension(url: string, format: string): string {
  return url.replace(/\.(zip|cbz|pdf|epub)$/i, `.${format}`)
}

/** Bar width, its progressbar value, and the percentage in the tab title while the download runs */
function setProgress(percent: number, inTitle = true): void {
  progress_bar.style.width = `${percent}%`
  progress_track.setAttribute('aria-valuenow', String(Math.round(percent)))
  document.title = inTitle ? `${Math.round(percent)}% · ${baseTitle}` : baseTitle
}

function updateDownloadHref(): void {
  if (!downloadBaseUrl) {
    return
  }

  progress_result.href = replaceArchiveExtension(downloadBaseUrl, progress_format.value)
}

function setDownloadLinkEnabled(enabled: boolean): void {
  progress_result.style.opacity = enabled ? '1' : '0.45'
  progress_result.style.color = enabled ? 'var(--text_color)' : 'color-mix(in srgb, var(--text_color), var(--background_color) 45%)'
  progress_result.style.pointerEvents = enabled ? 'auto' : 'none'
  progress_result.style.cursor = enabled ? 'pointer' : 'default'
  progress_result.setAttribute('aria-disabled', enabled ? 'false' : 'true')
}

function setStepDisabled(Container: HTMLElement, Status: HTMLElement): void {
  Container.style.opacity = '0.25'
  Status.style.animation = ''
  Status.style.backgroundColor = 'transparent'
  Status.style.borderColor = 'var(--text_color)'
}

function preparePackText(format: string): string {
  return tFormat('Preparing for {format}...', format)
}

function syncPackTextToSelection(): void {
  step_pack_text.textContent = preparePackText(progress_format.value)
}

function enterPrepareUI(format: string): void {
  isPreparingArchive = true
  setDownloadLinkEnabled(false)
  step_pack_text.textContent = preparePackText(format)
  step_finish_text.textContent = defaultFinishText
  statusAnimation(step_pack_container, step_pack_status, 'loading')
  setStepDisabled(step_finish_container, step_finish_status)
  progress_text.textContent = completedText || '90%'
  progress_text.style.color = 'var(--text_color)'
  setProgress(90, false)
}

function restoreCompletedUI(format?: string): void {
  step_pack_text.textContent = format ? preparePackText(format) : preparePackText(progress_format.value)
  step_finish_text.textContent = defaultFinishText
  statusAnimation(step_pack_container, step_pack_status, 'success')
  statusAnimation(step_finish_container, step_finish_status, 'success')
  progress_text.textContent = completedText
  progress_text.style.color = 'var(--text_color)'
  setProgress(100, false)
  setDownloadLinkEnabled(true)
  isPreparingArchive = false
}

function failPrepareUI(format: string): void {
  step_pack_text.textContent = preparePackText(format)
  step_finish_text.textContent = defaultFinishText
  statusAnimation(step_pack_container, step_pack_status, 'error')
  setStepDisabled(step_finish_container, step_finish_status)
  progress_text.textContent = tFormat('Failed to prepare {format}', format)
  progress_text.style.color = 'var(--error_color)'
  setProgress(90, false)
  setDownloadLinkEnabled(true)
  isPreparingArchive = false
}

function clickDownload(url: string, auto: 0 | 1): void {
  const a = document.createElement('a')
  a.href = url
  a.click()
  addHistory({ id: galleryId, title: galleryTitle, format: progress_format.value })
  track('file_download', { gallery, format: progress_format.value, source: 'page', auto })
}

/** Once per format and run; the first format counts from the start, later ones from their prepare request */
function reportReady(format: string, since: number): void {
  if (readyReported.has(format)) return
  readyReported.add(format)
  const seconds = Math.round((Date.now() - since) / 100) / 10
  track('download_ready', { gallery, format, pages: galleryPages || progressTotal, missing: missingPages, seconds, source: 'page' })
}

function sendSocketCommand(command: Record<string, unknown>): void {
  session.send(command)
}

function rejectPendingPrepare(reason: string): void {
  if (pendingPrepare) {
    pendingPrepare.reject(new Error(reason))
    pendingPrepare = null
  }
}

function handlePrepareEvent(message: { format?: string; status?: string; error?: string }): void {
  if (!pendingPrepare || message.format !== pendingPrepare.format) {
    return
  }

  if (message.status === 'ready') {
    pendingPrepare.resolve()
    pendingPrepare = null
    return
  }

  if (message.status === 'started') {
    pendingPrepare.onStarted()
    return
  }

  if (message.status === 'error') {
    pendingPrepare.reject(new Error(message.error || 'Prepare failed'))
    pendingPrepare = null
  }
}

async function prepareSelectedArchive(format: string): Promise<void> {
  if (pendingPrepare) {
    throw new Error('Another archive is already being prepared')
  }

  await new Promise<void>((resolve, reject) => {
    pendingPrepare = {
      format,
      resolve,
      reject,
      onStarted: () => enterPrepareUI(format)
    }
    try {
      sendSocketCommand({ type: 'prepare', format })
    } catch (error) {
      pendingPrepare = null
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

const queryFormat = new URLSearchParams(window.location.search).get('format')
const cookieFormat = getCookie('file_format')

function queueArchiveWorkflow(downloadAfterReady = false, auto = false): void {
  if (!downloadBaseUrl) {
    return
  }

  if (downloadAfterReady) {
    autoDownloadRequested = true
    autoDownloadIsAuto = auto ? 1 : 0
  }

  archiveWorkflowQueued = true
  if (archiveWorkflowRunning) {
    return
  }

  archiveWorkflowRunning = true
  void (async () => {
    while (archiveWorkflowQueued && downloadBaseUrl) {
      archiveWorkflowQueued = false

      const selectedFormat = progress_format.value
      updateDownloadHref()

      if (isOnDemandFormat(selectedFormat)) {
        const since = readyReported.size === 0 ? flowStart : Date.now()
        try {
          await prepareSelectedArchive(selectedFormat)
          reportReady(selectedFormat, since)
          updateDownloadHref()
          if (isPreparingArchive) {
            restoreCompletedUI(selectedFormat)
          }
        } catch {
          if (isPreparingArchive) {
            failPrepareUI(selectedFormat)
          }
          if (downloadBaseUrl) track('download_error', { gallery, format: selectedFormat, stage: 'pack', source: 'page' })
          autoDownloadRequested = false
          return
        }
      }

      if (progress_format.value !== selectedFormat) {
        archiveWorkflowQueued = true
        continue
      }

      if (autoDownloadRequested) {
        clickDownload(replaceArchiveExtension(downloadBaseUrl, progress_format.value), autoDownloadIsAuto)
        autoDownloadRequested = false
      }
    }
  })().finally(() => {
    archiveWorkflowRunning = false

    if (archiveWorkflowQueued && downloadBaseUrl) {
      queueArchiveWorkflow(autoDownloadRequested, autoDownloadIsAuto === 1)
    }
  })
}

if (isValidFormat(queryFormat)) {
  progress_format.value = queryFormat
} else if (isValidFormat(cookieFormat)) {
  progress_format.value = cookieFormat
} else {
  progress_format.value = 'zip'
}

syncPackTextToSelection()
let shownFormat = progress_format.value

progress_format.addEventListener('change', () => {
  track('format_change', { gallery, from: shownFormat, to: progress_format.value })
  shownFormat = progress_format.value
  setCookie('file_format', progress_format.value)
  updateDownloadHref()
  syncPackTextToSelection()

  if (completedText) {
    progress_text.textContent = completedText
    progress_text.style.color = 'var(--text_color)'
    queueArchiveWorkflow()
  }
})

progress_result.addEventListener('click', (event) => {
  if (!downloadBaseUrl) {
    event.preventDefault()
    return
  }

  event.preventDefault()
  queueArchiveWorkflow(true, false)
})

setDownloadLinkEnabled(false)

function setErrorState(message: string, stage: 'connect' | 'download' | 'pack', reported: 'connect' | 'download' | 'pack' | 'rate_limited' = stage): void {
  if (hasTerminalState) {
    return
  }

  track('download_error', { gallery, format: progress_format.value, stage: reported, source: 'page' })

  if (stage === 'connect') {
    statusAnimation(step_connect_container, step_connect_status, 'error')
  } else if (stage === 'download') {
    statusAnimation(step_download_container, step_download_status, 'error')
    step_download = false
  } else {
    if (step_download) {
      statusAnimation(step_download_container, step_download_status, 'success')
      step_download = false
    }

    statusAnimation(step_pack_container, step_pack_status, 'error')
    step_pack = false
  }

  progress_text.textContent = message
  progress_text.style.color = 'var(--error_color)'
  document.title = baseTitle
  setDownloadLinkEnabled(false)
  hasTerminalState = true
  completedText = ''
  retry_button.hidden = false
  retry_button.focus()
}

/** Error with the connection closed for good: no reconnect after a server-reported failure */
function fail(message: string, stage: 'connect' | 'download' | 'pack'): void {
  setErrorState(message, stage)
  rejectPendingPrepare('Connection closed')
  session.stop()
}

function currentStage(): 'connect' | 'download' | 'pack' {
  return step_pack ? 'pack' : step_download ? 'download' : 'connect'
}

function resetForRetry(): void {
  rejectPendingPrepare('Connection was retried')
  session.stop()

  hasReceivedAnyMessage = false
  hasTerminalState = false
  step_download = false
  step_pack = false
  downloadBaseUrl = ''
  completedText = ''
  isPreparingArchive = false
  archiveWorkflowQueued = false
  autoDownloadRequested = false
  delete progress_text.dataset['beforeReconnect']

  retry_button.hidden = true
  progress_warning.style.display = 'none'
  setDownloadLinkEnabled(false)
  step_connect_container.style.opacity = '1'
  step_connect_status.style.animation = '1s flashing infinite'
  step_connect_status.style.backgroundColor = 'transparent'
  step_connect_status.style.borderColor = 'var(--text_color)'
  setStepDisabled(step_download_container, step_download_status)
  setStepDisabled(step_pack_container, step_pack_status)
  setStepDisabled(step_finish_container, step_finish_status)
  syncPackTextToSelection()
  step_finish_text.textContent = defaultFinishText
  progress_text.textContent = '0%'
  progress_text.style.color = 'var(--text_color)'
  setProgress(0, false)
}

retry_button.addEventListener('click', () => {
  resetForRetry()
  // Asked for again, so download when ready even after a reload
  autoDownload = true
  connect()
})

/** The 0x02 warning as a sentence, from the translated templates */
function missingPagesText(payload: string): string {
  let warning: { missing?: unknown; count?: unknown; total?: unknown } = {}
  try {
    warning = JSON.parse(payload)
  } catch {
    // Still warn, without numbers
  }

  const pages = Array.isArray(warning.missing) ? warning.missing.filter((n): n is number => Number.isInteger(n)) : []
  const count = typeof warning.count === 'number' ? warning.count : pages.length
  const total = typeof warning.total === 'number' ? warning.total : 0
  missingPages = count
  if (total) progressTotal = total
  const fill = (template: string) =>
    template
      .replace('{count}', String(count || '?'))
      .replace('{total}', String(total || '?'))
      .replace('{pages}', pages.join(', ') + (count > pages.length ? ', …' : ''))

  const sentence = fill(t('{count} of {total} pages are no longer available and were left out.'))
  return pages.length ? `${sentence} ${fill(t('(pages {pages})'))}` : sentence
}

/** Only when enabled in Preferences and the tab is in the background */
function notifyReady(): void {
  if (!('Notification' in window) || Notification.permission !== 'granted' || getCookie('notify') !== '1' || !document.hidden) return
  try {
    const notification = new Notification('nZip', { body: `${t('Ready to download')}: ${galleryTitle}`, icon: '/Images/icon.png', tag: `nzip-${galleryId}` })
    notification.addEventListener('click', () => {
      window.focus()
      notification.close()
    })
  } catch {
    // Some mobile browsers only allow notifications from a service worker
  }
}

function handleBinary(buffer: Uint8Array): void {
  if (buffer.length === 0) {
    fail(t('Unexpected empty response from server'), session.opened ? 'download' : 'connect')
    return
  }

  hasReceivedAnyMessage = true
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  /**
   * 0x00 Download progress
   * 0x01 Download error
   * 0x02 Warning (pages left out)
   * 0x10 Pack progress
   * 0x11 Pack error
   * 0x20 Download link
   */

  if (buffer[0] === 0x00) {
    if (buffer.length < 5) {
      fail(t('Malformed download progress message'), 'download')
      return
    }

    if (!step_download) {
      statusAnimation(step_download_container, step_download_status, 'loading')
      step_download = true
    }

    const completed = view.getUint16(1)
    const total = view.getUint16(3)
    progressTotal = total

    if (total === 0) {
      fail(t('Malformed download progress message'), 'download')
      return
    }

    const progress = 10 + (80 / total) * completed
    progress_text.textContent = `${Math.round(progress)}% (${completed} / ${total})`
    setProgress(Math.min(90, progress))
  } else if (buffer[0] === 0x01) {
    statusAnimation(step_download_container, step_download_status, 'error')
    step_download = false

    const errorMessage = new TextDecoder().decode(buffer.slice(1)).trim()
    fail(errorMessage || t('Download failed'), 'download')
  } else if (buffer[0] === 0x02) {
    progress_warning.textContent = missingPagesText(new TextDecoder().decode(buffer.slice(1)))
    progress_warning.style.display = 'block'
  } else if (buffer[0] === 0x10) {
    if (step_download) {
      statusAnimation(step_download_container, step_download_status, 'success')
      step_download = false
    }

    if (!step_pack) {
      statusAnimation(step_pack_container, step_pack_status, 'loading')
      step_pack = true
    }

    progress_text.textContent = '90%'
    setProgress(90)
  } else if (buffer[0] === 0x11) {
    if (step_download) {
      statusAnimation(step_download_container, step_download_status, 'success')
      step_download = false
    }

    statusAnimation(step_pack_container, step_pack_status, 'error')
    step_pack = false

    const errorMessage = new TextDecoder().decode(buffer.slice(1)).trim()
    fail(errorMessage || t('Pack failed'), 'pack')
  } else if (buffer[0] === 0x20) {
    if (step_download) {
      statusAnimation(step_download_container, step_download_status, 'success')
      step_download = false
    }
    if (step_pack) {
      statusAnimation(step_pack_container, step_pack_status, 'success')
      step_pack = false
    }

    statusAnimation(step_finish_container, step_finish_status, 'success')

    const url = new TextDecoder().decode(buffer.slice(1)).trim()
    if (!url) {
      fail(t('Missing download link from server'), 'pack')
      return
    }

    const elapsedText = formatElapsedTime(startTime)
    completedText = `100% (${elapsedText})`
    syncPackTextToSelection()
    step_finish_text.textContent = defaultFinishText
    progress_text.textContent = completedText
    downloadBaseUrl = url
    updateDownloadHref()
    setDownloadLinkEnabled(true)
    setProgress(100, false)
    hasTerminalState = true
    notifyReady()
    if (!isOnDemandFormat(progress_format.value)) reportReady('zip', flowStart)
    queueArchiveWorkflow(autoDownload, true)
  } else {
    fail(t('Unexpected response from server'), currentStage())
  }
}

function connect(): void {
  flowStart = Date.now()
  progressTotal = 0
  missingPages = 0
  readyReported = new Set()
  track('download_start', { gallery, format: progress_format.value, source: 'page' })

  session = new GallerySocket(
    wsUrl,
    {
      open: (reconnected) => {
        if (!reconnected) {
          startTime = Date.now()

          step_connect_status.style.animation = ''
          step_connect_status.style.width = '0.75rem'
          step_connect_status.style.backgroundColor = 'var(--text_color)'

          progress_text.textContent = '10%'
          progress_text.style.color = 'var(--text_color)'
          setProgress(10)
        } else if (!hasTerminalState) {
          progress_text.textContent = progress_text.dataset['beforeReconnect'] || progress_text.textContent
        }

        sendSocketCommand({ type: 'start' })

        if (pendingPrepare) {
          sendSocketCommand({ type: 'prepare', format: pendingPrepare.format })
        }
      },

      message: (data) => {
        if (typeof data === 'string') {
          try {
            const message = JSON.parse(data) as { type?: string; format?: string; status?: string; error?: string }
            if (message.type === 'prepare') {
              handlePrepareEvent(message)
            }
          } catch {
            if (!hasTerminalState) {
              fail(t('Failed to parse server response'), currentStage())
            }
          }
          return
        }

        if (hasTerminalState) {
          return
        }

        try {
          handleBinary(new Uint8Array(data))
        } catch {
          rejectPendingPrepare('Connection closed before prepare completed')
          fail(t('Failed to parse server response'), currentStage())
        }
      },

      reconnecting: (attempt) => {
        if (hasTerminalState) return
        if (attempt === 1) progress_text.dataset['beforeReconnect'] = progress_text.textContent || ''
        progress_text.textContent = t('Reconnecting...')
      },

      closed: ({ opened }) => {
        rejectPendingPrepare('Connection closed during archive preparation')

        if (hasTerminalState) {
          return
        }

        if (!opened) {
          // A refused upgrade (rate limit) or no server at all
          setErrorState(t('Connection failed or rate limited'), 'connect', 'rate_limited')
        } else if (!hasReceivedAnyMessage) {
          setErrorState(t('Server busy or rate limited. Try again later.'), 'connect')
        } else {
          setErrorState(t('Connection closed before completion. Please try again.'), currentStage())
        }
      }
    },
    RECONNECT_MAX_ATTEMPTS
  )
  session.start()
}

connect()

onShortcuts({
  d: () => {
    if (progress_result.getAttribute('aria-disabled') === 'true') return false
    progress_result.click()
  }
})

// Cover: blurred until hovered (CSS) or toggled; already clear with the blur preference off
cover_toggle.setAttribute('aria-pressed', String(document.documentElement.classList.contains('no-blur')))
cover_toggle.addEventListener('click', () => {
  cover_toggle.setAttribute('aria-pressed', String(cover_toggle.getAttribute('aria-pressed') !== 'true'))
})

// On phones the cover can push the progress below the fold; bring it up once, unless the user already scrolled
let userScrolled = false
window.addEventListener('scroll', () => (userScrolled = true), { once: true, passive: true })

function revealProgress(): void {
  if (userScrolled) return
  if (progress_track.getBoundingClientRect().bottom > window.innerHeight) progress_track.scrollIntoView({ block: 'nearest' })
}

if (image_cover.complete) revealProgress()
else image_cover.addEventListener('load', revealProgress, { once: true })

copy_link.hidden = false
copy_link.addEventListener('click', async () => {
  track('copy_link', { gallery })
  const url = `${window.location.origin}/g/${galleryId}`
  let copied = false

  try {
    await navigator.clipboard.writeText(url)
    copied = true
  } catch {
    // No clipboard API (plain HTTP, older browsers): copy from a selected field
    const field = document.createElement('input')
    field.value = url
    field.readOnly = true
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    field.remove()
  }

  if (!copied) {
    window.prompt(t('Copy link'), url)
    return
  }

  copy_link.textContent = t('Link copied')
  setTimeout(() => (copy_link.textContent = t('Copy link')), 2000)
})
