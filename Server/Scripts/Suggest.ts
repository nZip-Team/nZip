// Search suggestions for input[data-suggest] (filters and tags), ported from nWrap's autocomplete

interface SuggestTag {
  id: number
  type: string
  name: string
  count: number
}

interface Hint {
  insert: string
  label: string
  key: string
}

type Item = { kind: 'search'; query: string } | { kind: 'hint'; hint: Hint } | { kind: 'tag'; tag: SuggestTag; negated: boolean }

const LIMIT = 10
const DEBOUNCE_MS = 120

const TAG_TYPES: Record<string, string> = {
  tag: 'tag', tags: 'tag',
  artist: 'artist', artists: 'artist',
  parody: 'parody', parodies: 'parody',
  character: 'character', characters: 'character',
  group: 'group', groups: 'group',
  language: 'language', languages: 'language',
  category: 'category', categories: 'category'
}

const HINTS: Hint[] = [
  { insert: 'tag:', label: 'tag:…', key: 'Filter by tag' },
  { insert: 'artist:', label: 'artist:…', key: 'Filter by artist' },
  { insert: 'parody:', label: 'parody:…', key: 'Filter by parody' },
  { insert: 'character:', label: 'character:…', key: 'Filter by character' },
  { insert: 'group:', label: 'group:…', key: 'Filter by group' },
  { insert: 'language:', label: 'language:…', key: 'Filter by language' },
  { insert: 'category:', label: 'category:…', key: 'Filter by category' },
  { insert: 'pages:', label: 'pages:N', key: 'Filter by page count' },
  { insert: 'favorites:', label: 'favorites:N', key: 'Filter by favorites' },
  { insert: 'uploaded:', label: 'uploaded:Nd', key: 'Filter by upload date' },
  { insert: 'title:"', label: 'title:"…"', key: 'Search title text' },
  { insert: 'jtitle:"', label: 'jtitle:"…"', key: 'Search Japanese title' }
]

const tagTerm = (tag: SuggestTag): string => `${tag.type}:"${tag.name}"`

/** The term at the caret: from the last space outside quotes to the end of the word */
function currentTerm(value: string, caret: number): { start: number; end: number; text: string } {
  let start = 0
  let inQuote = false
  for (let i = 0; i < caret; i++) {
    if (value[i] === '"') inQuote = !inQuote
    else if (!inQuote && /\s/.test(value[i])) start = i + 1
  }
  let end = caret
  while (end < value.length && !/\s/.test(value[end])) end++
  return { start, end, text: value.slice(start, caret) }
}

function element(tag: string, attrs: Record<string, string>, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  node.append(...children)
  return node
}

function attach(input: HTMLInputElement, index: number): void {
  const api = (input.dataset['api'] || '').replace(/\/+$/, '')
  const strings = JSON.parse(input.dataset['suggest'] || '{}') as Record<string, string>
  const t = (key: string) => strings[key] ?? key
  const count = new Intl.NumberFormat(document.documentElement.lang || undefined)

  const listId = `suggest-${index}`
  const box = element('div', { class: 'suggest', id: listId, role: 'listbox', 'aria-label': t('Search suggestions') })
  box.hidden = true
  const anchor = element('div', { class: 'suggest-anchor' })
  input.replaceWith(anchor)
  anchor.append(input, box)
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-controls', listId)
  input.setAttribute('aria-expanded', 'false')

  const cache = new Map<string, SuggestTag[]>()
  let items: Item[] = []
  let active = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  function close(): void {
    box.hidden = true
    items = []
    active = -1
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
  }

  function option(item: Item, i: number): HTMLElement {
    const attrs = { class: 'suggest-item', role: 'option', id: `${listId}-${i}`, 'data-i': String(i), 'aria-selected': String(i === active) }
    if (item.kind === 'search') return element('div', attrs, element('span', { class: 'suggest-muted' }, t('Search for')), element('strong', {}, item.query))
    if (item.kind === 'hint') return element('div', attrs, element('code', {}, item.hint.label), element('span', { class: 'suggest-muted' }, t(item.hint.key)))
    const { tag } = item
    return element(
      'div',
      attrs,
      element('span', { class: 'suggest-badge', 'data-type': tag.type }, t(tag.type)),
      element('span', { class: 'suggest-name' }, tag.name),
      element('span', { class: 'suggest-count' }, count.format(tag.count))
    )
  }

  function render(): void {
    if (items.length === 0) return close()
    box.replaceChildren(...items.map(option))
    box.hidden = false
    input.setAttribute('aria-expanded', 'true')
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  async function tags(type: string | null, query: string): Promise<SuggestTag[]> {
    const url = `${api}/api/v2/tags/search?${new URLSearchParams({ ...(type ? { type } : {}), query, limit: String(LIMIT) })}`
    const hit = cache.get(url)
    if (hit) return hit
    controller?.abort()
    controller = new AbortController()
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return []
    const result = (await response.json()) as SuggestTag[]
    cache.set(url, result)
    return result
  }

  async function update(): Promise<void> {
    const value = input.value
    const term = currentTerm(value, input.selectionStart ?? value.length)
    const header: Item[] = value.trim() ? [{ kind: 'search', query: value.trim() }] : []
    const parsed = /^(-?)([a-z]+):"?([^"]*)"?$/i.exec(term.text)
    const bare = term.text.replace(/^-/, '').replace(/"/g, '')
    const hintItems = (hints: Hint[]): Item[] => hints.map((hint) => ({ kind: 'hint', hint }))

    let next: Item[]
    if (!term.text) {
      next = [...header, ...hintItems(HINTS)]
    } else if (parsed && TAG_TYPES[parsed[2].toLowerCase()]) {
      const found = await tags(TAG_TYPES[parsed[2].toLowerCase()], parsed[3])
      next = [...header, ...found.map((tag): Item => ({ kind: 'tag', tag, negated: parsed[1] === '-' }))]
    } else if (!parsed && bare.length >= 2 && !/^\d+$/.test(bare)) {
      const hints = HINTS.filter((hint) => hint.insert.startsWith(bare.toLowerCase()))
      const found = await tags(null, bare)
      next = [...header, ...hintItems(hints), ...found.map((tag): Item => ({ kind: 'tag', tag, negated: term.text.startsWith('-') }))]
    } else {
      next = header
    }

    if (input.value !== value || document.activeElement !== input) return
    items = next
    active = -1
    render()
  }

  function schedule(): void {
    clearTimeout(timer)
    timer = setTimeout(() => {
      update().catch((error) => {
        if (error?.name !== 'AbortError') console.warn('Suggestions failed:', error)
      })
    }, DEBOUNCE_MS)
  }

  function replaceTerm(text: string): void {
    const term = currentTerm(input.value, input.selectionStart ?? input.value.length)
    input.value = input.value.slice(0, term.start) + text + input.value.slice(term.end)
    const caret = term.start + text.length
    input.setSelectionRange(caret, caret)
    input.focus()
    schedule()
  }

  function choose(item: Item): void {
    if (item.kind === 'search') {
      close()
      // Through the form, so its sort and the home page's ID/link handling apply
      if (input.form && typeof input.form.requestSubmit === 'function') input.form.requestSubmit()
      else window.location.href = `/search?q=${encodeURIComponent(item.query)}`
    } else if (item.kind === 'hint') {
      replaceTerm(item.hint.insert)
    } else {
      replaceTerm(`${item.negated ? '-' : ''}${tagTerm(item.tag)} `)
    }
  }

  input.addEventListener('input', schedule)
  input.addEventListener('click', schedule)
  input.addEventListener('blur', () => setTimeout(close, 150))

  input.addEventListener('keydown', (event) => {
    if (box.hidden) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      active = (active + step + items.length + 1) % (items.length + 1)
      if (active === items.length) active = -1
      render()
    } else if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
      // Also stops the page's own Enter handling (keypress, submit)
      event.preventDefault()
      choose(items[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  // Keep focus in the input while a row is pressed
  box.addEventListener('mousedown', (event) => event.preventDefault())
  box.addEventListener('click', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('.suggest-item')
    if (row) choose(items[Number(row.dataset['i'])])
  })
}

document.querySelectorAll<HTMLInputElement>('input[data-suggest]').forEach(attach)

export {}
