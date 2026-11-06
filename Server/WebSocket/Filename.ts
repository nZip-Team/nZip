/**
 * Generate a safe filename that doesn't exceed filesystem limits
 *
 * The name is stored with .zip and the other formats swap that extension
 * (.cbz, .pdf, .epub), so it has to fit 255 bytes with the longest of them.
 * A title too long for that is cut at a character boundary and marked with
 * an ellipsis, rather than dropped in favour of the bare ID.
 * @param galleryID Gallery ID
 * @param titles Object containing title options
 * @returns Sanitized filename within 255 bytes in every archive format
 */
export function generateFilename(galleryID: string | number, titles: { english?: string; pretty?: string }): string {
  const maxBaseBytes = 255 - Buffer.byteLength('.epub')
  const sanitize = (text: string) => text.replace(/[/\\?%*:|"<>]/g, '_')
  const fits = (base: string) => Buffer.byteLength(base) <= maxBaseBytes
  const prefix = `[${galleryID}] `

  const candidates = [titles.english, titles.pretty].filter((title): title is string => Boolean(title?.trim())).map(sanitize)
  const whole = candidates.find((title) => fits(`${prefix}${title}`))
  if (whole) return `${prefix}${whole}.zip`

  const longest = candidates[0]
  if (!longest) return `${galleryID}.zip`

  let base = prefix
  for (const char of longest) {
    if (!fits(`${base}${char}…`)) break
    base += char
  }
  return `${base.trimEnd()}….zip`
}
