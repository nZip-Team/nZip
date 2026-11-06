const KEYS = [
  'Search suggestions',
  'Search for',
  'Filter by tag',
  'Filter by artist',
  'Filter by parody',
  'Filter by character',
  'Filter by group',
  'Filter by language',
  'Filter by category',
  'Filter by page count',
  'Filter by favorites',
  'Filter by upload date',
  'Search title text',
  'Search Japanese title',
  'tag',
  'artist',
  'parody',
  'character',
  'group',
  'language',
  'category'
]

/** Translated strings for data-suggest (Server/Scripts/Suggest.ts) */
export default (tr: (section: string, key: string) => string): string => JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, tr('Suggest', key)])))
