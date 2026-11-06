const preferences_button = document.getElementById('preferences_button') as HTMLButtonElement
const preferences_modal = document.getElementById('preferences_modal') as HTMLDivElement
const preference_blur = document.getElementById('preference_blur') as HTMLInputElement
const language_list = document.getElementById('language_list') as HTMLDivElement

function getCookie(name: string): string | null {
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) return parts.pop()?.split(';').shift() || null
  return null
}

function setCookie(name: string, value: string): void {
  const expiryDate = new Date()
  expiryDate.setFullYear(expiryDate.getFullYear() + 1)
  document.cookie = `${name}=${value}; expires=${expiryDate.toUTCString()}; path=/; samesite=lax`
}

// Frame.tsx applies the no-blur class before paint
preference_blur.checked = getCookie('blur') !== '0'
preference_blur.addEventListener('change', () => {
  setCookie('blur', preference_blur.checked ? '1' : '0')
  document.documentElement.classList.toggle('no-blur', !preference_blur.checked)
})

async function loadLanguages(): Promise<void> {
  const currentLang = getCookie('language') || document.documentElement.lang.replace('-', '_') || 'en_us'
  language_list.replaceChildren()

  try {
    const response = await fetch('/Languages')
    const availableLanguages = (await response.json()) as { code: string; name: string; symbol: string }[]

    availableLanguages.sort((a, b) => {
      if (a.code === 'en_us') return -1
      if (b.code === 'en_us') return 1
      return a.name.localeCompare(b.name)
    })

    for (const lang of availableLanguages) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'text language-button'
      button.textContent = `${lang.symbol} ${lang.name}`
      button.lang = lang.code.replace('_', '-')
      button.dataset['current'] = (currentLang === lang.code).toString()

      button.addEventListener('click', () => {
        setCookie('language', lang.code)
        window.location.reload()
      })

      language_list.appendChild(button)
    }
  } catch {
    const errorText = document.createElement('p')
    errorText.className = 'text'
    errorText.textContent = 'Failed to load languages'
    errorText.style.textAlign = 'center'
    errorText.style.fontSize = '1rem'
    language_list.appendChild(errorText)
  }
}

function openPreferences(): void {
  preferences_modal.hidden = false
  preference_blur.focus()
  void loadLanguages()
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
  const focusable = Array.from(preferences_modal.querySelectorAll<HTMLElement>('button, input, a[href]')).filter((el) => !el.hasAttribute('disabled'))
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

export {}
