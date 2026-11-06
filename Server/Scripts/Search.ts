// Download buttons on search results, in the format last chosen on the download page

const grid = document.querySelector<HTMLElement>('.search-grid')
const labels = grid?.dataset ?? {}
const formats = ['zip', 'cbz', 'pdf', 'epub']
const RECONNECT_MAX_ATTEMPTS = 10

function preferredFormat(): string {
  const match = document.cookie.match(/(?:^|;\s*)file_format=([^;]+)/)
  const format = match ? decodeURIComponent(match[1]) : 'zip'
  return formats.includes(format) ? format : 'zip'
}

function saveFile(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.click()
}

function download(button: HTMLButtonElement): void {
  const id = button.dataset['id']!
  const format = preferredFormat()
  const label = format.toUpperCase()
  const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/g/${id}`
  let attempts = 0
  let finished = false

  const show = (text: string, title = '') => {
    button.textContent = text
    button.title = title
  }

  const finish = (text: string, title = '') => {
    finished = true
    button.disabled = false
    show(text, title)
  }

  button.disabled = true
  show('…')

  const connect = () => {
    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'
    let link = ''

    socket.addEventListener('open', () => {
      attempts = 0
      socket.send(JSON.stringify({ type: 'start' }))
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as { type?: string; status?: string; error?: string }
        if (message.type !== 'prepare') return
        if (message.status === 'ready') {
          saveFile(link.replace(/\.zip$/i, `.${format}`))
          finish(label)
          socket.close()
        } else if (message.status === 'error') {
          finish('!', message.error || labels['failed'] || '')
          socket.close()
        }
        return
      }

      const bytes = new Uint8Array(event.data as ArrayBuffer)
      if (bytes[0] === 0x00 && bytes.length >= 5) {
        const view = new DataView(bytes.buffer)
        show(`${view.getUint16(1)}/${view.getUint16(3)}`)
      } else if (bytes[0] === 0x10) {
        show(labels['packing'] || '…')
      } else if (bytes[0] === 0x01 || bytes[0] === 0x11) {
        finish('!', new TextDecoder().decode(bytes.slice(1)).trim() || labels['failed'] || '')
      } else if (bytes[0] === 0x20 && !link) {
        link = new TextDecoder().decode(bytes.slice(1)).trim()
        if (format === 'zip') {
          saveFile(link)
          finish(label)
          socket.close()
        } else {
          show(labels['packing'] || '…')
          socket.send(JSON.stringify({ type: 'prepare', format }))
        }
      }
    })

    socket.addEventListener('close', (event) => {
      if (finished) return
      if ([1001, 1006, 1012].includes(event.code) && attempts < RECONNECT_MAX_ATTEMPTS) {
        setTimeout(connect, Math.min(1000 * 2 ** attempts++, 5000))
        return
      }
      finish('!', labels['failed'] || '')
    })
  }

  connect()
}

grid?.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('.search-card-download')
  if (button && !button.disabled) download(button)
})

document.querySelectorAll<HTMLButtonElement>('.search-card-download').forEach((button) => {
  button.textContent = preferredFormat().toUpperCase()
})

export {}
