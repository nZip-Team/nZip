import { version } from './package.json'

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

  apiHost:
    process.env['API_URL'] ??
    (() => {
      throw new Error('API_URL is not defined')
    })(),
  imageHost:
    process.env['IMAGE_URL'] ??
    (() => {
      throw new Error('IMAGE_URL is not defined')
    })(),

  concurrentImageDownloads: parseInt(process.env['CONCURRENT_IMAGE_DOWNLOADS'] || '16', 10),
  rateLimit: parseInt(process.env['RATE_LIMIT'] || '10', 10),

  analytics: process.env['ANALYTICS'] || '',

  trustXForwardedFor: parseBooleanEnv(process.env['TRUST_X_FORWARDED_FOR']),
  trustedProxies: parseListEnv(process.env['TRUSTED_PROXIES']),

  development: process.env.NODE_ENV === 'development'
}
