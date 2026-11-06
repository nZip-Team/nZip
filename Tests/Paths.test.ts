import './env'
import path from 'path'
import { describe, expect, test } from 'bun:test'

import { getArchiveContentType, sanitizePath } from '../Server/Tools/Paths'
import { canonicalGalleryID, isGalleryID } from '../Server/Tools/GalleryID'
import { generateFilename } from '../Server/WebSocket/Filename'

const base = path.resolve('/srv/cache/Downloads')

describe('sanitizePath', () => {
  test('names inside the base directory', () => {
    expect(sanitizePath('abc', base)).toBe(path.join(base, 'abc'))
    expect(sanitizePath('[1] a b.zip', path.join(base, 'abc'))).toBe(path.join(base, 'abc', '[1] a b.zip'))
  })

  test('traversal is refused', () => {
    expect(sanitizePath('../etc/passwd', base)).toBeNull()
    expect(sanitizePath('..\\..\\x', base)).toBeNull()
    expect(sanitizePath('a/../../b', base)).toBeNull()
  })

  test('the base itself', () => {
    expect(sanitizePath('', base)).toBe(base)
    expect(sanitizePath('.', base)).toBe(base)
  })
})

describe('getArchiveContentType', () => {
  test('archive formats only', () => {
    expect(getArchiveContentType('a.zip')).toBe('application/zip')
    expect(getArchiveContentType('a.cbz')).toBe('application/vnd.comicbook+zip')
    expect(getArchiveContentType('a.pdf')).toBe('application/pdf')
    expect(getArchiveContentType('a.epub')).toBe('application/epub+zip')
    expect(getArchiveContentType('a.zip.lock')).toBeNull()
    expect(getArchiveContentType('.missing-pages.json')).toBeNull()
  })
})

describe('gallery IDs', () => {
  test('digits only, up to 8, without leading zeros', () => {
    expect(canonicalGalleryID('228922')).toBe('228922')
    expect(canonicalGalleryID('000123')).toBe('123')
    expect(canonicalGalleryID('99999999')).toBe('99999999')
  })

  test('what Number() would have taken is refused', () => {
    for (const value of ['1e3', '0x10', 'Infinity', ' 12', '12 ', '-1', '1.5', '0', '000', '123456789', '', '../../x', '1/../2']) {
      expect(canonicalGalleryID(value)).toBeNull()
    }
    expect(canonicalGalleryID(undefined)).toBeNull()
  })

  test('isGalleryID wants the canonical form', () => {
    expect(isGalleryID(123)).toBe(true)
    expect(isGalleryID('0123')).toBe(false)
    expect(isGalleryID('..%2Fx')).toBe(false)
  })
})

describe('generateFilename', () => {
  test('ID and English title', () => {
    expect(generateFilename(1, { english: 'Hello', pretty: 'H' })).toBe('[1] Hello.zip')
  })

  test('falls back to the pretty title, then the bare ID', () => {
    expect(generateFilename(2, { english: ' ', pretty: 'Pretty' })).toBe('[2] Pretty.zip')
    expect(generateFilename(3, {})).toBe('3.zip')
  })

  test('characters a filesystem or URL would trip on are replaced', () => {
    expect(generateFilename(4, { english: 'a/b\\c?d%e*f:g|h"i<j>k' })).toBe('[4] a_b_c_d_e_f_g_h_i_j_k.zip')
  })

  test('long titles are cut at a character boundary and fit 255 bytes as .epub', () => {
    const name = generateFilename(5, { english: 'あ'.repeat(200) })
    expect(name.endsWith('….zip')).toBe(true)
    expect(Buffer.byteLength(name.replace(/\.zip$/, '.epub'))).toBeLessThanOrEqual(255)
    expect(name).not.toContain('�')
  })

  test('a shorter title that fits is preferred over cutting the longer one', () => {
    expect(generateFilename(6, { english: 'x'.repeat(300), pretty: 'Short' })).toBe('[6] Short.zip')
  })
})
