export type ParsedRange = {
  start: number
  end: number
  partial: boolean
  unsatisfiable: boolean
}

/**
 * Parse the Range header from the request
 * @param rangeHeader The Range header value
 * @param fileSize The total size of the file being served
 * @returns The resolved byte range and whether it is partial or unsatisfiable
 */
export function parseRangeHeader(rangeHeader: string | undefined, fileSize: number): ParsedRange {
  const fullRange: ParsedRange = {
    start: 0,
    end: Math.max(fileSize - 1, 0),
    partial: false,
    unsatisfiable: false,
  }

  if (!rangeHeader || fileSize <= 0) return fullRange

  try {
    const [unit, rawRange] = rangeHeader.split('=')
    if (unit?.trim().toLowerCase() !== 'bytes' || !rawRange) return fullRange

    const [rangeValue] = rawRange.split(',')
    const [startStr, endStr] = rangeValue.split('-').map((part) => part.trim())

    if (!startStr && !endStr) return fullRange

    let start = 0
    let end = fileSize - 1

    if (!startStr) {
      const suffixLength = parseInt(endStr, 10)
      if (isNaN(suffixLength) || suffixLength <= 0) return fullRange
      if (suffixLength >= fileSize) return fullRange
      start = fileSize - suffixLength
    } else {
      start = parseInt(startStr, 10)
      if (isNaN(start) || start < 0) return fullRange
      if (start >= fileSize) {
        return {
          ...fullRange,
          unsatisfiable: true,
        }
      }

      if (endStr) {
        end = parseInt(endStr, 10)
        if (isNaN(end) || end < start) {
          return {
            ...fullRange,
            unsatisfiable: true,
          }
        }
        end = Math.min(end, fileSize - 1)
      }
    }

    const partial = start > 0 || end < fileSize - 1
    return { start, end, partial, unsatisfiable: false }
  } catch {
    return fullRange
  }
}

/**
 * Whether a Range may be honoured under If-Range (RFC 9110 13.1.5)
 * @param ifRange The If-Range header value
 * @param etag Strong ETag of the current representation
 * @param lastModified Last modification time of the current representation
 * @returns true without If-Range, or when it names the current representation
 */
export function ifRangeMatches(ifRange: string | undefined, etag: string, lastModified: Date): boolean {
  if (!ifRange) return true
  const value = ifRange.trim()

  // A weak tag never matches
  if (value.startsWith('W/')) return false
  if (value.startsWith('"')) return value === etag

  const date = Date.parse(value)
  if (Number.isNaN(date)) return false
  return Math.floor(date / 1000) === Math.floor(lastModified.getTime() / 1000)
}
