const input_sauce = document.getElementById('input_sauce') as HTMLInputElement
const text_sauce = document.getElementById('text_sauce') as HTMLHeadingElement

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

let target = Math.round(Math.random() * 999999)
let current = 0

setInterval(() => {
  current += (target - current) / 40
  text_sauce.innerHTML = Math.round(current).toString().padStart(6, '0')

  if (Math.abs(target - current) < 0.1) target = Math.round(Math.random() * 999999)
}, 10)
