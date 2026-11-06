export interface PolicySources {
  apiHost: string
  imageHost: string
  analytics: string
  /** CONTENT_SECURITY_POLICY: replaces the derived policy, "off" disables it */
  override: string
}

// Hosts a known analytics snippet loads from, and the ones it reports to
const ANALYTICS_REPORT_ORIGINS: Array<[RegExp, string[]]> = [
  [/cloudflareinsights\.com/i, ['https://cloudflareinsights.com']],
  [/googletagmanager\.com|google-analytics\.com/i, ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com']]
]

// The Cloudflare edge may inject its Web Analytics beacon on its own
const CLOUDFLARE_BEACON = { script: 'https://static.cloudflareinsights.com', connect: 'https://cloudflareinsights.com' }

function origin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

/** Origins of the absolute URLs in an HTML snippet */
export function originsIn(html: string): string[] {
  const origins = new Set<string>()
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>`)]+/gi)) {
    const value = origin(match[0])
    if (value) origins.add(value)
  }
  return Array.from(origins)
}

/**
 * The page policy without the WebSocket origin, which depends on the request
 * Inline scripts and styles stay allowed: the pages use style attributes and
 * an inline preferences script in the head, and ANALYTICS is inserted as is.
 * @returns The policy, or null when it is turned off
 */
export function buildContentSecurityPolicy(sources: PolicySources): ((host: string | undefined) => string) | null {
  if (sources.override.toLowerCase() === 'off') return null
  if (sources.override) return () => sources.override

  const analyticsOrigins = originsIn(sources.analytics)
  const reportOrigins = ANALYTICS_REPORT_ORIGINS.filter(([pattern]) => pattern.test(sources.analytics)).flatMap(([, origins]) => origins)
  const unique = (values: Array<string | null>) => Array.from(new Set(values.filter((value): value is string => Boolean(value)))).join(' ')

  const script = unique(["'self'", "'unsafe-inline'", ...analyticsOrigins, CLOUDFLARE_BEACON.script])
  const img = unique(["'self'", 'data:', 'blob:', origin(sources.imageHost), ...analyticsOrigins])
  const connect = unique(["'self'", origin(sources.apiHost), ...analyticsOrigins, ...reportOrigins, CLOUDFLARE_BEACON.connect])

  const fixed = [`default-src 'self'`, `script-src ${script}`, `style-src 'self' 'unsafe-inline'`, `img-src ${img}`, `font-src 'self' data:`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`]

  return (host) => {
    // Older Safari does not count ws: and wss: as 'self'
    const socket = host && /^[a-z0-9.-]+(?::\d{1,5})?$|^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(host) ? ` ws://${host} wss://${host}` : ''
    return [...fixed, `connect-src ${connect}${socket}`].join('; ')
  }
}
