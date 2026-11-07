// Single-key shortcuts, ignored while typing, with Ctrl/Alt/Meta held, or while the preferences dialog is open

import { track } from './Track'

function isTyping(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLElement && element.isContentEditable) return true
  return element.matches('input, textarea, select')
}

/** An action returning false did nothing, and the key keeps its default */
export function onShortcuts(actions: Record<string, () => boolean | void>): void {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return
    if (isTyping(document.activeElement)) return
    if (document.getElementById('preferences_modal')?.hidden === false) return

    const action = actions[event.key]
    if (action && action() !== false) {
      event.preventDefault()
      track('shortcut', { key: event.key })
    }
  })
}

/** Focus a search field and select its text, for "/" */
export function focusField(input: HTMLInputElement | null): void {
  if (!input) return
  input.focus()
  input.select()
}
