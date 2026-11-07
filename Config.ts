import { version } from './package.json'

type Env = Record<string, string | undefined>

// An empty or relative value must fail at start, not later as broken image URLs
export function requireURL(name: string, env: Env = process.env): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)

  try {
    new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL, got ${JSON.stringify(value)}`)
  }

  return value.replace(/\/+$/, '')
}

export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function parseListEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/** A typo such as RATE_LIMIT=1O must stop the start, not become NaN and disable a limit */
export function numberEnv(name: string, fallback: number, options: { integer?: boolean; min?: number; max?: number } = {}, env: Env = process.env): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback

  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`)
  if (options.integer && !Number.isInteger(value)) throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`)
  if (options.min !== undefined && value < options.min) throw new Error(`${name} must be at least ${options.min}, got ${value}`)
  if (options.max !== undefined && value > options.max) throw new Error(`${name} must be at most ${options.max}, got ${value}`)
  return value
}

export function oneOfEnv<T extends string>(name: string, allowed: readonly T[], fallback: T, env: Env = process.env): T {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  const match = allowed.find((value) => value === raw)
  if (!match) throw new Error(`${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`)
  return match
}

const drainTimeoutMs = numberEnv('DRAIN_TIMEOUT_SECONDS', 60, { min: 0 }) * 1000

export default {
  version,

  httpHost: process.env['HOST'] || 'http://localhost',
  httpPort: numberEnv('PORT', 3000, { integer: true, min: 1, max: 65535 }),

  apiHost: requireURL('API_URL'),
  imageHost: requireURL('IMAGE_URL'),

  concurrentImageDownloads: numberEnv('CONCURRENT_IMAGE_DOWNLOADS', 16, { integer: true, min: 1 }),
  rateLimit: numberEnv('RATE_LIMIT', 10, { integer: true, min: 0 }),
  searchRateLimit: numberEnv('SEARCH_RATE_LIMIT', 20, { min: 0 }),
  searchHourlyLimit: numberEnv('SEARCH_HOURLY_LIMIT', 300, { integer: true, min: 0 }),

  analytics: process.env['ANALYTICS'] || '',

  // Empty = derived from API_URL, IMAGE_URL and ANALYTICS; "off" sends none
  contentSecurityPolicy: process.env['CONTENT_SECURITY_POLICY']?.trim() || '',

  trustXForwardedFor: parseBooleanEnv(process.env['TRUST_X_FORWARDED_FOR']),
  trustedProxies: parseListEnv(process.env['TRUSTED_PROXIES']),

  logFormat: oneOfEnv('LOG_FORMAT', ['text', 'json'] as const, 'text'),

  // Local disk only when S3_BUCKET is empty
  s3: {
    endpoint: process.env['S3_ENDPOINT'] || '',
    bucket: process.env['S3_BUCKET'] || '',
    region: process.env['S3_REGION'] || 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY_ID'] || '',
    secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] || '',
    prefix: (process.env['S3_PREFIX'] || '').replace(/^\/+|\/+$/g, ''),
    virtualHostedStyle: parseBooleanEnv(process.env['S3_VIRTUAL_HOSTED_STYLE'])
  },

  // 0 = never evict / no cap
  archiveRetentionDays: numberEnv('ARCHIVE_RETENTION_DAYS', 7, { min: 0 }),
  archiveMaxGB: numberEnv('ARCHIVE_MAX_GB', 0, { min: 0 }),

  drainTimeoutMs,
  // Whole shutdown: drain, then running file downloads (15 s more), then the core. stop_grace_period must be longer
  shutdownBudgetMs: drainTimeoutMs + 25000,

  // Bracket access on purpose: Bun.build replaces the dot form with the build's mode, which made every image "development"
  development: process.env['NODE_ENV'] === 'development'
}
