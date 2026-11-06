// A gallery ID, or an nhentai.net / nhentai.zip gallery link (/search redirects the same forms server-side)
const GALLERY_LINK = /^(?:https?:\/\/)?(?:www\.)?nhentai\.(?:net|zip)\/g\/(\d+)/i

export function galleryId(value: string): string | null {
  const text = value.trim()
  const link = text.match(GALLERY_LINK)
  if (link) return link[1]
  return /^\d+$/.test(text) ? text : null
}
