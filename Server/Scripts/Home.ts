const input_sauce = document.getElementById('input_sauce') as HTMLInputElement
const text_sauce = document.getElementById('text_sauce') as HTMLHeadingElement

function handleInput(searchOnText: boolean) {
  const value = input_sauce.value.trim()
  const link = value.match(/^(?:https?:\/\/)?(?:www\.)?nhentai\.(?:net|zip)\/g\/(\d+)/i)

  if (link) window.location.href = '/g/' + link[1]
  else if (/^\d+$/.test(value)) window.location.href = '/g/' + value
  // Text searches only on Enter, not on leaving the field
  else if (value && searchOnText) window.location.href = '/search?q=' + encodeURIComponent(value)
}

input_sauce.onchange = () => handleInput(false)

input_sauce.addEventListener('keypress', (event) => {
  if (event.key === 'Enter') {
    handleInput(true)
  }
})

let target = Math.round(Math.random() * 999999)
let current = 0

setInterval(() => {
  current += (target - current) / 40
  text_sauce.innerHTML = Math.round(current).toString().padStart(6, '0')

  if (Math.abs(target - current) < 0.1) target = Math.round(Math.random() * 999999)
}, 10)
