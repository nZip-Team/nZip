import './env'
import { describe, expect, test } from 'bun:test'

import { OP_DOWNLOAD_ERROR, OP_DOWNLOAD_LINK, OP_DOWNLOAD_PROGRESS, OP_DOWNLOAD_WARNING, OP_PACK_ERROR, OP_PACK_PROGRESS, encodeError, encodeLink, encodePackStart, encodeProgress, encodeWarning, sanitizeReason, warningPayload } from '../Server/Protocol'
import { decodeMessage, parseClientCommand } from '../Server/WebSocket/Commands'

describe('Protocol', () => {
  test('progress is two big-endian uint16 values', () => {
    expect([...encodeProgress(3, 513)]).toEqual([OP_DOWNLOAD_PROGRESS, 0, 3, 2, 1])
  })

  test('progress clamps to uint16', () => {
    const frame = encodeProgress(-5, 1e6)
    expect(frame.readUint16BE(1)).toBe(0)
    expect(frame.readUint16BE(3)).toBe(0xffff)
    expect(encodeProgress(NaN, 1.9).readUint16BE(3)).toBe(1)
  })

  test('pack start and link frames', () => {
    expect([...encodePackStart()]).toEqual([OP_PACK_PROGRESS])
    const link = encodeLink('/download/abc/[1] x.zip')
    expect(link[0]).toBe(OP_DOWNLOAD_LINK)
    expect(link.subarray(1).toString('utf8')).toBe('/download/abc/[1] x.zip')
  })

  test('errors carry an optional reason', () => {
    expect([...encodeError(OP_PACK_ERROR)]).toEqual([OP_PACK_ERROR])
    expect(encodeError(OP_DOWNLOAD_ERROR, 'gone').subarray(1).toString()).toBe('gone')
    expect([...encodeError(OP_DOWNLOAD_ERROR, '\n\t')]).toEqual([OP_DOWNLOAD_ERROR])
  })

  test('reasons lose control characters and stay within 512 bytes', () => {
    expect(sanitizeReason('a\u0000b\nc  d')).toBe('a b c d')
    const long = sanitizeReason('é'.repeat(600))
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(512)
    expect(long.endsWith('…')).toBe(true)
    expect(long).not.toContain('�')
  })

  test('warnings list at most 10 pages', () => {
    const payload = JSON.parse(warningPayload([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 40))
    expect(payload).toEqual({ missing: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], count: 12, total: 40 })
    expect(encodeWarning('{}')[0]).toBe(OP_DOWNLOAD_WARNING)
  })
})

describe('client commands', () => {
  test('start and prepare', () => {
    expect(parseClientCommand('{"type":"start"}')).toEqual({ type: 'start' })
    expect(parseClientCommand('{"type":"prepare","format":"epub"}')).toEqual({ type: 'prepare', format: 'epub' })
  })

  test('anything else is ignored', () => {
    expect(parseClientCommand('{"type":"prepare","format":"rar"}')).toBeNull()
    expect(parseClientCommand('{"type":"prepare","format":["zip"]}')).toBeNull()
    expect(parseClientCommand('{"type":"stop"}')).toBeNull()
    expect(parseClientCommand('null')).toBeNull()
    expect(parseClientCommand('not json')).toBeNull()
  })

  test('binary messages are read as UTF-8', () => {
    const text = '{"type":"start"}'
    expect(decodeMessage(text)).toBe(text)
    expect(decodeMessage(Buffer.from(text))).toBe(text)
    expect(decodeMessage(new TextEncoder().encode(text).buffer)).toBe(text)
    expect(decodeMessage(new TextEncoder().encode(text))).toBe(text)
  })
})
