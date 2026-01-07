const input_sauce = document.getElementById('input_sauce') as HTMLInputElement
const text_sauce = document.getElementById('text_sauce') as HTMLHeadingElement
const language_selector = document.getElementById('language_selector') as HTMLImageElement

function handleInput() {
  if (input_sauce.value.substring(0, 22) === 'https://nhentai.net/g/') window.location.replace('/g/' + input_sauce.value.substring(22))
  else if (!isNaN(parseInt(input_sauce.value))) window.location.href = '/g/' + input_sauce.value
}

input_sauce.onchange = handleInput

input_sauce.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    handleInput()
  }
})

function getCookie(name: string): string | null {
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) return parts.pop()?.split(';').shift() || null
  return null
}

const modal = document.getElementById('language_modal') as HTMLDivElement
const languageList = document.getElementById('language_list') as HTMLDivElement

language_selector.addEventListener('click', async () => {
  const currentLang = getCookie('language') || 'en_us'

  languageList.innerHTML = ''
  modal.style.display = 'flex'

  try {
    const response = await fetch('/Languages')
    const availableLanguages = await response.json()

    for (const lang of availableLanguages) {
      const button = document.createElement('button')
      button.className = 'text language-button'
      button.textContent = `${lang.symbol} ${lang.name}`
      button.dataset['code'] = lang.code
      button.dataset['current'] = (currentLang === lang.code).toString()

      button.addEventListener('click', () => {
        const expiryDate = new Date()
        expiryDate.setFullYear(expiryDate.getFullYear() + 1)
        document.cookie = `language=${lang.code}; expires=${expiryDate.toUTCString()}; path=/`
        window.location.reload()
      })

      languageList.appendChild(button)
    }
  } catch (error) {
    const errorText = document.createElement('p')
    errorText.className = 'text'
    errorText.textContent = 'Failed to load languages'
    errorText.style.textAlign = 'center'
    errorText.style.fontSize = '1rem'
    languageList.appendChild(errorText)
  }
})

modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    modal.style.display = 'none'
  }
})

let target = Math.round(Math.random() * 999999)
let current = 0

setInterval(() => {
  current += (target - current) / 40
  text_sauce.innerHTML = Math.round(current).toString().padStart(6, '0')

  if (Math.abs(target - current) < 0.1) target = Math.round(Math.random() * 999999)
}, 10)
