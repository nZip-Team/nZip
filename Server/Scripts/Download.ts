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
const step_finish_container = document.getElementById('step-finish-container') as HTMLDivElement
const step_finish_status = document.getElementById('step-finish-status') as HTMLDivElement
const progress_text = document.getElementById('progress-text') as HTMLHeadingElement
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
  progress_result.style.opacity = '0'
  hasTerminalState = true
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
})

socket.addEventListener('message', async (event) => {
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
      progress_text.textContent = `100% (${elapsedText})`
      progress_result.href = url
      progress_result.style.opacity = '1'
      progress_bar.style.width = '100%'
      hasTerminalState = true

      const a = document.createElement('a')
      a.href = url
      a.click()
    } else {
      const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
      setErrorState('Unexpected response from server', stage)
      socket.close()
    }
  } catch {
    const stage = step_pack ? 'pack' : step_download ? 'download' : 'connect'
    setErrorState('Failed to parse server response', stage)
    socket.close()
  }
})

socket.addEventListener('error', () => {
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
