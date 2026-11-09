import './env'
import { describe, expect, test } from 'bun:test'

import { EDGE_CACHE_CONTROL, isEdgeCacheable } from '../Server/Tools/EdgeCache'

describe('EdgeCache', () => {
  test('home and gallery pages without a language cookie are cacheable', () => {
    expect(isEdgeCacheable('GET', '/', 200, undefined, false)).toBe(true)
    expect(isEdgeCacheable('GET', '/g/228922', 200, 'theme=dark; blur=0', false)).toBe(true)
  })

  test('a language cookie, a cookie being set, errors and other methods or paths are not', () => {
    expect(isEdgeCacheable('GET', '/', 200, 'theme=dark; language=fr_fr', false)).toBe(false)
    expect(isEdgeCacheable('GET', '/', 200, 'language=fr_fr', false)).toBe(false)
    expect(isEdgeCacheable('GET', '/', 200, undefined, true)).toBe(false)
    expect(isEdgeCacheable('GET', '/g/1', 404, undefined, false)).toBe(false)
    expect(isEdgeCacheable('GET', '/g/1', 429, undefined, false)).toBe(false)
    expect(isEdgeCacheable('POST', '/', 200, undefined, false)).toBe(false)
    expect(isEdgeCacheable('GET', '/search', 200, undefined, false)).toBe(false)
    expect(isEdgeCacheable('GET', '/metrics', 200, undefined, false)).toBe(false)
  })

  test('a cookie that only ends in language is not the language cookie', () => {
    expect(isEdgeCacheable('GET', '/', 200, 'xlanguage=1', false)).toBe(true)
  })

  test('browsers revalidate, the CDN keeps it for two minutes', () => {
    expect(EDGE_CACHE_CONTROL).toBe('public, max-age=0, s-maxage=120')
  })
})
