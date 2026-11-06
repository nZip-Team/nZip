/**
 * Binary WebSocket frames, `[opcode][payload]`:
 *   0x00 Download progress  uint16BE completed, uint16BE total
 *   0x01 Download error     optional UTF-8 reason (terminal)
 *   0x02 Download warning   UTF-8 JSON {"missing": [up to 10 pages], "count": n, "total": pages} (the flow goes on)
 *   0x10 Pack progress      no payload
 *   0x11 Pack error         optional UTF-8 reason (terminal)
 *   0x20 Download link      UTF-8 link
 */

export const OP_DOWNLOAD_PROGRESS = 0x00
export const OP_DOWNLOAD_ERROR = 0x01
export const OP_DOWNLOAD_WARNING = 0x02
export const OP_PACK_PROGRESS = 0x10
export const OP_PACK_ERROR = 0x11
export const OP_DOWNLOAD_LINK = 0x20

export type ErrorOpcode = typeof OP_DOWNLOAD_ERROR | typeof OP_PACK_ERROR

const MAX_REASON_BYTES = 512
const MAX_MISSING_PAGES_LISTED = 10

function clampUint16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(0xffff, Math.trunc(value))
}

/** No control characters, bounded length */
export function sanitizeReason(reason: string): string {
  const flattened = reason.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flattened) return ''

  const encoded = Buffer.from(flattened, 'utf8')
  if (encoded.byteLength <= MAX_REASON_BYTES) return flattened

  // Room for the ellipsis, minus any character the cut split
  const head = encoded.subarray(0, MAX_REASON_BYTES - 3).toString('utf8').replace(/�+$/, '').trimEnd()
  return `${head}…`
}

export function encodeProgress(completed: number, total: number): Buffer {
  const buffer = Buffer.alloc(5)
  buffer[0] = OP_DOWNLOAD_PROGRESS
  buffer.writeUint16BE(clampUint16(completed), 1)
  buffer.writeUint16BE(clampUint16(total), 3)
  return buffer
}

export function encodePackStart(): Buffer {
  return Buffer.from([OP_PACK_PROGRESS])
}

export function encodeLink(link: string): Buffer {
  return Buffer.concat([Buffer.from([OP_DOWNLOAD_LINK]), Buffer.from(link, 'utf8')])
}

export function encodeError(opcode: ErrorOpcode, reason?: string): Buffer {
  const text = reason ? sanitizeReason(reason) : ''
  if (!text) return Buffer.from([opcode])
  return Buffer.concat([Buffer.from([opcode]), Buffer.from(text, 'utf8')])
}

export function warningPayload(missingPages: number[], total: number): string {
  return JSON.stringify({ missing: missingPages.slice(0, MAX_MISSING_PAGES_LISTED), count: missingPages.length, total })
}

export function encodeWarning(payload: string | Buffer): Buffer {
  return Buffer.concat([Buffer.from([OP_DOWNLOAD_WARNING]), Buffer.from(payload)])
}
