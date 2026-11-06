import { galleryId } from './Shared/Gallery'
import { readHistory, clearHistory } from './Shared/History'
import { onShortcuts, focusField } from './Shared/Shortcuts'

const form_sauce = document.getElementById('form_sauce') as HTMLFormElement
const input_sauce = document.getElementById('input_sauce') as HTMLInputElement
const text_sauce = document.getElementById('text_sauce') as HTMLDivElement
const history_section = document.getElementById('history') as HTMLElement
const history_list = document.getElementById('history_list') as HTMLUListElement
const history_clear = document.getElementById('history_clear') as HTMLButtonElement

// Text goes to /search as a normal form submit; IDs and links skip the redirect
form_sauce.addEventListener('submit', (event) => {
  const value = input_sauce.value.trim()
  const id = galleryId(value)

  if (id) {
    event.preventDefault()
    window.location.href = '/g/' + id
  } else if (!value) {
    event.preventDefault()
  }
})

onShortcuts({ '/': () => focusField(input_sauce) })

function renderHistory(): void {
  const entries = readHistory()
  const date = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium' })

  history_section.hidden = entries.length === 0
  history_list.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement('li')
      item.className = 'history-item'

      // Text only, so the blur preference has nothing to cover
      const link = document.createElement('a')
      link.className = 'text'
      link.href = `/g/${encodeURIComponent(entry.id)}`
      link.title = entry.title
      link.textContent = entry.title || entry.id

      const meta = document.createElement('span')
      meta.className = 'history-meta'
      meta.textContent = `${entry.id} · ${entry.format.toUpperCase()} · ${date.format(entry.date)}`

      item.append(link, meta)
      return item
    })
  )
}

history_clear.addEventListener('click', () => {
  clearHistory()
  renderHistory()
  input_sauce.focus()
})

renderHistory()
// Coming back from a download page through the back/forward cache
window.addEventListener('pageshow', (event) => {
  if (event.persisted) renderHistory()
})

// Background counter: eases toward a random number, paused while hidden, static under reduced motion
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const randomNumber = () => Math.round(Math.random() * 999999)

let target = randomNumber()
let current = 0
let shown = ''
let lastFrame = 0
let frame = 0

function showNumber(value: number): void {
  const text = Math.round(value).toString().padStart(6, '0')
  if (text !== shown) text_sauce.textContent = shown = text
}

function tick(now: number): void {
  // Same easing as the old 10 ms timer (1/40 of the gap per step), scaled to the frame time
  const elapsed = lastFrame ? Math.min(now - lastFrame, 100) : 16
  lastFrame = now
  current += (target - current) * (1 - Math.pow(1 - 1 / 40, elapsed / 10))
  showNumber(current)

  if (Math.abs(target - current) < 0.5) target = randomNumber()
  frame = requestAnimationFrame(tick)
}

function startCounter(): void {
  if (frame || document.hidden || reducedMotion.matches) return
  lastFrame = 0
  frame = requestAnimationFrame(tick)
}

function stopCounter(): void {
  cancelAnimationFrame(frame)
  frame = 0
}

document.addEventListener('visibilitychange', () => (document.hidden ? stopCounter() : startCounter()))
reducedMotion.addEventListener('change', () => (reducedMotion.matches ? stopCounter() : startCounter()))

showNumber(reducedMotion.matches ? target : 0)
startCounter()
