import { Scope, Style } from '@lightbery/scope'

import type { ScriptScope } from '../Types'

const scope: ScriptScope = new Scope(undefined)

scope.AttributeManager.createAttribute('style:dynamic:minheight', {
  script: (element, value) => {
    // Update The Height
    function update(): void {
      let totalHeight: number = 0

      for (const child of Array.from(element.children)) {
        const bound = child.element!.getBoundingClientRect()

        totalHeight += bound.height
      }

      element.style.minHeight = Style.parseValue(value.replace('<height>', `${totalHeight}px`))
    }

    update()

    element.listen(window, 'load', update)
    element.listen(window, 'resize', update)
  }
})

new Scope(document.body)

type States = 'loading' | 'success'

function statusAnimation(Container: HTMLDivElement, Status: HTMLDivElement, state: States): void {
  if (state === 'loading') {
    Container.style.opacity = '1'
    Status.style.animation = '1s flashing infinite'
    Status.style.backgroundColor = 'var(--text_color)'
  } else if (state === 'success') {
    Container.style.opacity = '1'
    Status.style.animation = ''
    Status.style.backgroundColor = 'var(--text_color)'
  }
}

const image_cover = document.getElementById('image-cover') as HTMLDivElement
const step_connect_status = document.getElementById('step-connect-status') as HTMLDivElement
const step_download_container = document.getElementById('step-download-container') as HTMLDivElement
const step_download_status = document.getElementById('step-download-status') as HTMLDivElement
const step_pack_container = document.getElementById('step-pack-container') as HTMLDivElement
const step_pack_status = document.getElementById('step-pack-status') as HTMLDivElement
const step_finish_container = document.getElementById('step-finish-container') as HTMLDivElement
const step_finish_status = document.getElementById('step-finish-status') as HTMLDivElement
const progress_text = document.getElementById('progress-text') as HTMLElement
const progress_result = document.getElementById('progress-result') as HTMLLinkElement
const progress_bar = document.getElementById('progress-bar') as HTMLDivElement

const socket = new WebSocket(window.location.href)

socket.addEventListener('open', () => {
  step_connect_status.style.animation = ''
  step_connect_status.style.width = '0.75rem'
  step_connect_status.style.backgroundColor = 'var(--text_color)'

  progress_text.innerHTML = '10%'
  progress_bar.style.width = '10%'

  let step_download: boolean = false
  let step_pack: boolean = false

  socket.addEventListener('message', async event => {
    const raw = await event.data.arrayBuffer()
    const buffer = new Uint8Array(raw)
    const view = new DataView(raw)

    /**
     * 0x00 Download progress
     * 0x01 Download error
     * 0x10 Pack progress
     * 0x11 Pack error
     * 0x20 Download link
     */

    if (buffer[0] === 0x00) {
      if (!step_download) {
        statusAnimation(step_download_container, step_download_status, 'loading')
        step_download = true
      }

      const completed = view.getUint16(1)
      const total = view.getUint16(3)

      progress_text.innerHTML = `${Math.round(10 + (80 / total) * completed)}% (${completed} / ${total})`
      progress_bar.style.width = `${10 + (80 / total) * completed}%`
    } else if (buffer[0] === 0x01) {
    } else if (buffer[0] === 0x10) {
      if (step_download) {
        statusAnimation(step_download_container, step_download_status, 'success')
        step_download = false
      }

      if (!step_pack) {
        statusAnimation(step_pack_container, step_pack_status, 'loading')
        step_pack = true
      }

      const completed = view.getUint16(1)
      const total = view.getUint16(3)

      progress_text.innerHTML = `${Math.round(90 + (10 / total) * completed)}%` // Not implemented: (${completed} / ${total})
      progress_bar.style.width = `${90 + (10 / total) * completed}%`
    } else if (buffer[0] === 0x11) {
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

      const url = new TextDecoder().decode(buffer)

      progress_text.innerHTML = '100%'
      progress_result.href = url
      progress_result.style.opacity = '1'
      progress_bar.style.width = '100%'

      const a = document.createElement('a')
      a.href = url
      a.click()
    }
  })
})

let blured: boolean = true

image_cover.addEventListener('click', () => {
  image_cover.style.filter = blured ? 'blur(0px)' : 'blur(2.5px)'

  blured = !blured
})

image_cover.addEventListener('load', () => {
  window.scrollTo(0, document.body.scrollHeight)
})
