/**
 * Update the minimum height of an element based on its children's heights
 */
function updateDynamicMinHeight(): void {
  const body = document.body
  const extraHeight = body.getAttribute('data-dynamic-minheight') || '0px'

  let totalHeight = 0

  for (const child of Array.from(body.children) as HTMLElement[]) {
    const bound = child.getBoundingClientRect()
    totalHeight += bound.height
  }

  const extraHeightValue = parseFloat(extraHeight)
  const extraHeightUnit = extraHeight.replace(/[\d.]/g, '')

  let extraHeightPx = 0
  if (extraHeightUnit === 'rem') {
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize)
    extraHeightPx = extraHeightValue * rootFontSize
  } else if (extraHeightUnit === 'px') {
    extraHeightPx = extraHeightValue
  }

  body.style.minHeight = `${totalHeight + extraHeightPx}px`
}

// Initialize dynamic min-height
updateDynamicMinHeight()
window.addEventListener('load', updateDynamicMinHeight)
window.addEventListener('resize', updateDynamicMinHeight)

type States = 'loading' | 'success' | 'error'

function formatElapsedTime(startTime: number): string {
  const elapsedSeconds = (Date.now() - startTime) / 1000

  if (elapsedSeconds < 60) {
    return `${elapsedSeconds.toFixed(2)} sec`
  }

  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = Math.floor(elapsedSeconds % 60)
  return `${minutes} min ${seconds} sec`
}

function statusAnimation(Container: HTMLDivElement, Status: HTMLDivElement, state: States): void {
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
    Status.style.borderColor = '#ff4444'
    Status.style.backgroundColor = '#ff4444'
  }
}

const image_cover = document.getElementById('image-cover') as HTMLImageElement
const step_connect_container = document.getElementById('step-connect-container') as HTMLDivElement
const step_connect_status = document.getElementById('step-connect-status') as HTMLDivElement
const step_download_container = document.getElementById('step-download-container') as HTMLDivElement
const step_download_status = document.getElementById('step-download-status') as HTMLDivElement
const step_pack_container = document.getElementById('step-pack-container') as HTMLDivElement
const step_pack_status = document.getElementById('step-pack-status') as HTMLDivElement
const step_pack_text = document.getElementById('step-pack-text') as HTMLHeadingElement
const step_finish_container = document.getElementById('step-finish-container') as HTMLDivElement
const step_finish_status = document.getElementById('step-finish-status') as HTMLDivElement
const step_finish_text = document.getElementById('step-finish-text') as HTMLHeadingElement
const progress_text = document.getElementById('progress-text') as HTMLHeadingElement
const progress_format = document.getElementById('progress-format') as HTMLSelectElement
const progress_result = document.getElementById('progress-result') as HTMLAnchorElement
const progress_bar = document.getElementById('progress-bar') as HTMLDivElement

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
const wsPath = window.location.pathname.replace(/^\/g\//, '/ws/g/')
const socket = new WebSocket(`${wsProtocol}//${window.location.host}${wsPath}${window.location.search}`)
socket.binaryType = 'arraybuffer'

let hasOpened = false
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
const validFormats = ['zip', 'cbz', 'pdf', 'epub'] as const
const onDemandFormats = ['cbz', 'pdf', 'epub'] as const
let pendingPrepare:
  | { format: string; resolve: () => void; reject: (error: Error) => void; onStarted: () => void }
  | null = null
const defaultFinishText = step_finish_text.textContent || 'Finish!'

function isValidFormat(format: string | null): format is typeof validFormats[number] {
  return format !== null && validFormats.includes(format as typeof validFormats[number])
}

function isOnDemandFormat(format: string): format is typeof onDemandFormats[number] {
  return onDemandFormats.includes(format as typeof onDemandFormats[number])
}

function getCookie(name: string): string | null {
  const prefix = `${name}=`
  for (const part of document.cookie.split(';')) {
    const cookie = part.trim()
    if (cookie.startsWith(prefix)) {
      return decodeURIComponent(cookie.slice(prefix.length))
    }
  }
  return null
}

function setCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
}

function replaceArchiveExtension(url: string, format: string): string {
  return url.replace(/\.(zip|cbz|pdf|epub)$/i, `.${format}`)
}

function updateDownloadHref(): void {
  if (!downloadBaseUrl) {
    return
  }

  progress_result.href = replaceArchiveExtension(downloadBaseUrl, progress_format.value)
}

function setDownloadLinkEnabled(enabled: boolean): void {
  progress_result.style.opacity = enabled ? '1' : '0.45'
  progress_result.style.color = enabled
    ? 'var(--text_color)'
    : 'color-mix(in srgb, var(--text_color), var(--background_color) 45%)'
  progress_result.style.pointerEvents = enabled ? 'auto' : 'none'
  progress_result.style.cursor = enabled ? 'pointer' : 'default'
  progress_result.setAttribute('aria-disabled', enabled ? 'false' : 'true')
}

function setStepDisabled(Container: HTMLDivElement, Status: HTMLDivElement): void {
  Container.style.opacity = '0.25'
  Status.style.animation = ''
  Status.style.backgroundColor = 'transparent'
  Status.style.borderColor = 'var(--text_color)'
}

function preparePackText(format: string): string {
  return `Preparing for ${format.toUpperCase()}...`
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
  progress_bar.style.width = '90%'
}

function restoreCompletedUI(format?: string): void {
  step_pack_text.textContent = format ? preparePackText(format) : preparePackText(progress_format.value)
  step_finish_text.textContent = defaultFinishText
  statusAnimation(step_pack_container, step_pack_status, 'success')
  statusAnimation(step_finish_container, step_finish_status, 'success')
  progress_text.textContent = completedText
  progress_text.style.color = 'var(--text_color)'
  progress_bar.style.width = '100%'
  setDownloadLinkEnabled(true)
  isPreparingArchive = false
}

function failPrepareUI(format: string): void {
  step_pack_text.textContent = preparePackText(format)
  step_finish_text.textContent = defaultFinishText
  statusAnimation(step_pack_container, step_pack_status, 'error')
  setStepDisabled(step_finish_container, step_finish_status)
  progress_text.textContent = `Failed to prepare ${format.toUpperCase()}`
  progress_text.style.color = '#ff4444'
  progress_bar.style.width = '90%'
  setDownloadLinkEnabled(true)
  isPreparingArchive = false
}

function clickDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.click()
}

function sendSocketCommand(command: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('Connection is not open')
  }
  socket.send(JSON.stringify(command))
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

function queueArchiveWorkflow(downloadAfterReady = false): void {
  if (!downloadBaseUrl) {
    return
  }

  if (downloadAfterReady) {
    autoDownloadRequested = true
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
        try {
          await prepareSelectedArchive(selectedFormat)
          updateDownloadHref()
          if (isPreparingArchive) {
            restoreCompletedUI(selectedFormat)
          }
        } catch {
          if (isPreparingArchive) {
            failPrepareUI(selectedFormat)
          }
          autoDownloadRequested = false
          return
        }
      }

      if (progress_format.value !== selectedFormat) {
        archiveWorkflowQueued = true
        continue
      }

      if (autoDownloadRequested) {
        clickDownload(replaceArchiveExtension(downloadBaseUrl, progress_format.value))
        autoDownloadRequested = false
      }
    }
  })().finally(() => {
    archiveWorkflowRunning = false

    if (archiveWorkflowQueued && downloadBaseUrl) {
      queueArchiveWorkflow(autoDownloadRequested)
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

progress_format.addEventListener('change', () => {
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
  queueArchiveWorkflow(true)
})

setDownloadLinkEnabled(false)

function setErrorState(message: string, stage: 'connect' | 'download' | 'pack'): void {
  if (hasTerminalState) {
    return
  }

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
  progress_text.style.color = '#ff4444'
  setDownloadLinkEnabled(false)
  hasTerminalState = true
  completedText = ''
}

async function toBuffer(data: Blob | ArrayBuffer | string): Promise<Uint8Array | null> {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data)
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer())
  }

  return null
}

socket.addEventListener('open', () => {
  hasOpened = true
  startTime = Date.now()

  step_connect_status.style.animation = ''
  step_connect_status.style.width = '0.75rem'
  step_connect_status.style.backgroundColor = 'var(--text_color)'

  progress_text.textContent = '10%'
  progress_text.style.color = 'var(--text_color)'
  progress_bar.style.width = '10%'

  sendSocketCommand({ type: 'start' })
})

socket.addEventListener('message', async (event) => {
  if (typeof event.data === 'string') {
    try {
      const message = JSON.parse(event.data) as { type?: string; format?: string; status?: string; error?: string }
      if (message.type === 'prepare') {
        handlePrepareEvent(message)
      }
    } catch {
      if (!hasTerminalState) {
        const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
        setErrorState('Failed to parse server response', stage)
        socket.close()
      }
    }
    return
  }

  if (hasTerminalState) {
    return
  }

  try {
    const buffer = await toBuffer(event.data)
    if (!buffer || buffer.length === 0) {
      setErrorState('Unexpected empty response from server', hasOpened ? 'download' : 'connect')
      socket.close()
      return
    }

    hasReceivedAnyMessage = true
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

    /**
     * 0x00 Download progress
     * 0x01 Download error
     * 0x10 Pack progress
     * 0x11 Pack error
     * 0x20 Download link
     */

    if (buffer[0] === 0x00) {
      if (buffer.length < 5) {
        setErrorState('Malformed download progress message', 'download')
        socket.close()
        return
      }

      if (!step_download) {
        statusAnimation(step_download_container, step_download_status, 'loading')
        step_download = true
      }

      const completed = view.getUint16(1)
      const total = view.getUint16(3)

      if (total === 0) {
        setErrorState('Malformed download progress message', 'download')
        socket.close()
        return
      }

      const progress = 10 + (80 / total) * completed
      progress_text.textContent = `${Math.round(progress)}% (${completed} / ${total})`
      progress_bar.style.width = `${Math.min(90, progress)}%`
    } else if (buffer[0] === 0x01) {
      statusAnimation(step_download_container, step_download_status, 'error')
      step_download = false

      const errorMessage = new TextDecoder().decode(buffer.slice(1)).trim()
      setErrorState(errorMessage || 'Download failed', 'download')
      socket.close()
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
      progress_bar.style.width = '90%'
    } else if (buffer[0] === 0x11) {
      if (step_download) {
        statusAnimation(step_download_container, step_download_status, 'success')
        step_download = false
      }

      statusAnimation(step_pack_container, step_pack_status, 'error')
      step_pack = false

      const errorMessage = new TextDecoder().decode(buffer.slice(1)).trim()
      setErrorState(errorMessage || 'Pack failed', 'pack')
      socket.close()
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
        setErrorState('Missing download link from server', 'pack')
        socket.close()
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
      progress_bar.style.width = '100%'
      hasTerminalState = true
      queueArchiveWorkflow(true)
    } else {
      const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
      setErrorState('Unexpected response from server', stage)
      socket.close()
    }
  } catch {
    if (pendingPrepare) {
      pendingPrepare.reject(new Error('Connection closed before prepare completed'))
      pendingPrepare = null
    }
    const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
    setErrorState('Failed to parse server response', stage)
    socket.close()
  }
})

socket.addEventListener('error', () => {
  if (pendingPrepare) {
    pendingPrepare.reject(new Error('Connection failed during archive preparation'))
    pendingPrepare = null
  }

  if (hasTerminalState) {
    return
  }

  const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
  const message = hasOpened
    ? 'Connection lost before completion. Please try again.'
    : 'Connection failed or rate limited'
  setErrorState(message, stage)
})

socket.addEventListener('close', () => {
  if (pendingPrepare) {
    pendingPrepare.reject(new Error('Connection closed during archive preparation'))
    pendingPrepare = null
  }

  if (hasTerminalState) {
    return
  }

  if (!hasOpened || !hasReceivedAnyMessage) {
    setErrorState('Server busy or rate limited. Try again later.', 'connect')
    return
  }

  const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
  setErrorState('Connection closed before completion. Please try again.', stage)
})

let blurred: boolean = true

image_cover.addEventListener('click', () => {
  image_cover.style.filter = blurred ? 'blur(0px)' : 'blur(2.5px)'

  blurred = !blurred
})

image_cover.addEventListener('load', () => {
  window.scrollTo(0, document.body.scrollHeight)
})
