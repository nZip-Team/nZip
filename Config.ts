import { version } from './package.json'

// An empty or relative value must fail at start, not later as broken image URLs
function requireURL(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)

  try {
    new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL, got ${JSON.stringify(value)}`)
  }

  return value.replace(/\/+$/, '')
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parseListEnv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export default {
  version,

  httpHost: process.env['HOST'] || 'http://localhost',
  httpPort: parseInt(process.env['PORT'] || '3000', 10),

  apiHost: requireURL('API_URL'),
  imageHost: requireURL('IMAGE_URL'),

  concurrentImageDownloads: parseInt(process.env['CONCURRENT_IMAGE_DOWNLOADS'] || '16', 10),
  rateLimit: parseInt(process.env['RATE_LIMIT'] || '10', 10),

  analytics: process.env['ANALYTICS'] || '',

  trustXForwardedFor: parseBooleanEnv(process.env['TRUST_X_FORWARDED_FOR']),
  trustedProxies: parseListEnv(process.env['TRUSTED_PROXIES']),

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
  archiveRetentionDays: parseFloat(process.env['ARCHIVE_RETENTION_DAYS'] || '7'),
  archiveMaxGB: parseFloat(process.env['ARCHIVE_MAX_GB'] || '0'),

  drainTimeoutMs: parseInt(process.env['DRAIN_TIMEOUT_SECONDS'] || '60', 10) * 1000,

  development: process.env.NODE_ENV === 'development'
}
