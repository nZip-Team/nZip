import './env'
import { describe, expect, test } from 'bun:test'

import { ifRangeMatches, parseRangeHeader } from '../Server/Tools/Range'

describe('parseRangeHeader', () => {
  test('no header is the whole file', () => {
    expect(parseRangeHeader(undefined, 100)).toEqual({ start: 0, end: 99, partial: false, unsatisfiable: false })
  })

  test('bounded range', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toEqual({ start: 10, end: 19, partial: true, unsatisfiable: false })
  })

  test('open range runs to the end', () => {
    expect(parseRangeHeader('bytes=90-', 100)).toEqual({ start: 90, end: 99, partial: true, unsatisfiable: false })
  })

  test('end past the file is clamped', () => {
    expect(parseRangeHeader('bytes=50-1000', 100)).toMatchObject({ start: 50, end: 99, partial: true })
  })

  test('suffix range', () => {
    expect(parseRangeHeader('bytes=-10', 100)).toMatchObject({ start: 90, end: 99, partial: true })
  })

  test('suffix longer than the file is the whole file', () => {
    expect(parseRangeHeader('bytes=-500', 100)).toMatchObject({ start: 0, end: 99, partial: false })
  })

  test('start past the end is unsatisfiable', () => {
    expect(parseRangeHeader('bytes=100-', 100).unsatisfiable).toBe(true)
  })

  test('end before start is unsatisfiable', () => {
    expect(parseRangeHeader('bytes=20-10', 100).unsatisfiable).toBe(true)
  })

  test('only the first of several ranges is served', () => {
    expect(parseRangeHeader('bytes=0-9,20-29', 100)).toMatchObject({ start: 0, end: 9, partial: true })
  })

  test('other units and garbage fall back to the whole file', () => {
    expect(parseRangeHeader('items=0-5', 100).partial).toBe(false)
    expect(parseRangeHeader('bytes=abc', 100).partial).toBe(false)
    expect(parseRangeHeader('bytes=-', 100).partial).toBe(false)
  })

  test('empty file', () => {
    expect(parseRangeHeader('bytes=0-10', 0)).toEqual({ start: 0, end: 0, partial: false, unsatisfiable: false })
  })
})

describe('ifRangeMatches', () => {
  const etag = '"abc-123"'
  const modified = new Date('2026-11-06T10:00:00Z')

  test('no If-Range allows the range', () => {
    expect(ifRangeMatches(undefined, etag, modified)).toBe(true)
  })

  test('the current ETag allows it, another one does not', () => {
    expect(ifRangeMatches('"abc-123"', etag, modified)).toBe(true)
    expect(ifRangeMatches('"other"', etag, modified)).toBe(false)
  })

  test('a weak ETag never matches', () => {
    expect(ifRangeMatches('W/"abc-123"', etag, modified)).toBe(false)
  })

  test('dates compare to the second', () => {
    expect(ifRangeMatches(modified.toUTCString(), etag, new Date(modified.getTime() + 500))).toBe(true)
    expect(ifRangeMatches(new Date(modified.getTime() - 60000).toUTCString(), etag, modified)).toBe(false)
    expect(ifRangeMatches('not a date', etag, modified)).toBe(false)
  })
})
