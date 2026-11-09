import Config from '../../Config'

/** Origin of a URL, or null when it is not an absolute http(s) URL */
function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * Other origins every page talks to (the API, the image host, the tracker), so the browser can open
 * those connections while it is still reading the HTML. Same-origin pages need nothing.
 */
export const PRECONNECT_ORIGINS: string[] = [
  ...new Set(
    [originOf(Config.apiHost), originOf(Config.imageHost), originOf(/\bsrc="([^"]+)"/.exec(Config.analytics)?.[1])].filter((origin): origin is string => origin !== null && origin !== originOf(Config.httpHost))
  )
]

/** `Link` header for HTML responses; a CDN with Early Hints sends it before the page itself is ready */
export const PRECONNECT_LINK = PRECONNECT_ORIGINS.map((origin) => `<${origin}>; rel=preconnect`).join(', ')
