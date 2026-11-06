import { getCookie, setCookie, deleteCookie } from './Shared/Cookie'

const preferences_button = document.getElementById('preferences_button') as HTMLButtonElement
const preferences_modal = document.getElementById('preferences_modal') as HTMLDivElement
const preference_blur = document.getElementById('preference_blur') as HTMLInputElement
const preference_notify = document.getElementById('preference_notify') as HTMLInputElement
const preference_notify_group = document.getElementById('preference_notify_group') as HTMLDivElement
const theme_inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="preference_theme"]'))
const language_list = document.getElementById('language_list') as HTMLDivElement

// Frame.tsx applies the no-blur class and the theme before paint
preference_blur.checked = getCookie('blur') !== '0'
preference_blur.addEventListener('change', () => {
  setCookie('blur', preference_blur.checked ? '1' : '0')
  document.documentElement.classList.toggle('no-blur', !preference_blur.checked)
})

const currentTheme = getCookie('theme')
for (const input of theme_inputs) {
  input.checked = input.value === (currentTheme === 'light' || currentTheme === 'dark' ? currentTheme : 'system')
  input.addEventListener('change', () => {
    if (!input.checked) return
    const root = document.documentElement
    if (input.value === 'system') {
      deleteCookie('theme')
      root.removeAttribute('data-theme')
    } else {
      setCookie('theme', input.value)
      root.setAttribute('data-theme', input.value)
    }
    const color = input.value === 'system' ? null : input.value === 'light' ? '#ffffff' : '#000000'
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
      meta.content = color ?? (meta.media.includes('light') ? '#ffffff' : '#000000')
    })
  })
}

// Off by default; only offered where the browser has notifications at all
if ('Notification' in window) {
  preference_notify_group.hidden = false
  preference_notify.checked = getCookie('notify') === '1' && Notification.permission === 'granted'
  preference_notify.addEventListener('change', async () => {
    if (!preference_notify.checked) {
      setCookie('notify', '0')
      return
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
    preference_notify.checked = permission === 'granted'
    setCookie('notify', preference_notify.checked ? '1' : '0')
  })
}

// The list is rendered server-side; the current language comes marked from there
for (const button of Array.from(language_list.querySelectorAll<HTMLButtonElement>('.language-button'))) {
  button.addEventListener('click', () => {
    const code = button.dataset['code']
    if (!code) return
    setCookie('language', code)
    window.location.reload()
  })
}

function openPreferences(): void {
  preferences_modal.hidden = false
  preference_blur.focus()
}

function closePreferences(): void {
  preferences_modal.hidden = true
  preferences_button.focus()
}

preferences_button.addEventListener('click', openPreferences)

preferences_modal.addEventListener('click', (event) => {
  if (event.target === preferences_modal) closePreferences()
})

document.addEventListener('keydown', (event) => {
  if (preferences_modal.hidden) return
  if (event.key === 'Escape') return closePreferences()
  if (event.key !== 'Tab') return

  // Keep Tab inside the dialog
  const focusable = Array.from(preferences_modal.querySelectorAll<HTMLElement>('button, input, a[href]')).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
})
