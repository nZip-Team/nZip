import { version } from './package.json'

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
  sessionStoreType: process.env['SESSION_STORE'] || 'sqlite',
  analytics: process.env['ANALYTICS'] || '',

  development: process.env.NODE_ENV === 'development'
}
