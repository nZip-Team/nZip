import type { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'

import Config from '../../Config'

import LiveReload from '../Modules/LiveReload'
import type { AppEnv } from '../Render'
import type WebSocketHandler from '../WebSocket'
import { getIP, getRemoteAddress } from '../Tools/ClientIP'
import { canonicalGalleryID } from '../Tools/GalleryID'
import { clientTag } from '../Tools/Log'
import { rateLimited } from '../Tools/Metrics'
import RateLimiter from '../Tools/RateLimiter'
import { isLoopbackAddress } from '../Tools/TrustedProxy'

export default function registerWebSocket(app: Hono<AppEnv>, deps: { handler: WebSocketHandler }): void {
  if (Config.development) {
    app.get(
      '/dev/livereload',
      upgradeWebSocket(() => ({
        onOpen: (_evt, ws) => {
          if (ws.raw) LiveReload.add(ws.raw)
        },
        onClose: (_evt, ws) => {
          if (ws.raw) LiveReload.remove(ws.raw)
        }
      }))
    )
  }

  const limiter = Config.rateLimit > 0 ? new RateLimiter(Config.rateLimit, 60 * 1000) : null

  app.get(
    '/ws/g/:id',
    async (c, next) => {
      // The decoded param goes into an API path: /ws/g/..%2F..%2Fx must never get that far
      const id = canonicalGalleryID(c.req.param('id'))
      if (!id) return c.text('Bad Request', 400)

      // Local test clients, in development only: in production every request arrives from the proxy
      if (limiter && !(Config.development && isLoopbackAddress(getRemoteAddress(c)))) {
        const ip = getIP(c)
        if (!limiter.allow(ip)) {
          rateLimited.inc({ kind: 'ws_upgrade' })
          c.header('Retry-After', String(limiter.getRetryAfterSeconds(ip) || 60))
          return c.text('Too Many Requests', 429)
        }
      }
      await next()
    },
    upgradeWebSocket((c) => deps.handler.handle(canonicalGalleryID(c.req.param('id'))!, clientTag(getIP(c))))
  )
}
