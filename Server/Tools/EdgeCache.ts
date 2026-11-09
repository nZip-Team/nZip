/** How long a CDN may keep the home and gallery pages, in seconds (browsers get max-age=0 and revalidate) */
export const EDGE_CACHE_SECONDS = 120

export const EDGE_CACHE_CONTROL = `public, max-age=0, s-maxage=${EDGE_CACHE_SECONDS}`

/**
 * Whether a page response is the same for every visitor and may be kept by a CDN. The home page and the
 * gallery pages only differ by language, which comes from the `language` cookie or `?lang=` (part of the
 * CDN's cache key). Anything with a language cookie, a cookie being set, or a non-200 status is left alone.
 */
export function isEdgeCacheable(method: string, path: string, status: number, cookieHeader: string | undefined, setsCookie: boolean): boolean {
  if (method !== 'GET' || status !== 200 || setsCookie) return false
  if (path !== '/' && !path.startsWith('/g/')) return false
  return !/(?:^|;\s*)language=/.test(cookieHeader ?? '')
}
