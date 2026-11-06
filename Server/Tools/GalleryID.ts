const GALLERY_ID = /^\d{1,8}$/

/**
 * Validate a gallery ID from a URL
 * Number() would also take 1e3, 0x10 or Infinity, and a decoded param may hold "../"
 * @param id Raw ID
 * @returns The ID without leading zeros, or null when it is not a gallery ID
 */
export function canonicalGalleryID(id: string | undefined | null): string | null {
  if (!id || !GALLERY_ID.test(id)) return null
  const value = Number.parseInt(id, 10)
  return value > 0 ? String(value) : null
}

export function isGalleryID(id: string | number): boolean {
  return canonicalGalleryID(String(id)) === String(id)
}
