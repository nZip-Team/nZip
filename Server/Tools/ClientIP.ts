import type { Context } from 'hono'
import { getConnInfo } from 'hono/bun'

import Config from '../../Config'

import Log from './Log'
import { isPrivateAddress, isTrustedProxy, loadTrustedProxies, parseIPAddress, type TrustedProxyRule } from './TrustedProxy'

const trustedProxyRules = loadTrustedProxies(Config.trustedProxies, (entry, reason) => {
  Log.warn(`Ignoring invalid TRUSTED_PROXIES entry "${entry}": ${reason}`)
})

if (Config.trustXForwardedFor && trustedProxyRules.length === 0) {
  Log.warn('TRUST_X_FORWARDED_FOR is enabled, but TRUSTED_PROXIES is empty or invalid; X-Forwarded-For will be ignored')
}

export interface ClientIPOptions {
  trustXForwardedFor: boolean
  rules: TrustedProxyRule[]
}

/**
 * Resolve the client address of a request
 * @param remote Address of the TCP peer
 * @param header Reads a request header
 * @param options Which peers may name the client
 * @returns The normalized client address, or 'unknown'
 */
export function resolveClientIP(remote: string | undefined, header: (name: string) => string | undefined, options: ClientIPOptions): string {
  const remoteAddress = parseIPAddress(remote)

  if (options.trustXForwardedFor && remoteAddress && isTrustedProxy(remoteAddress, options.rules)) {
    // Set by Cloudflare, not the visitor
    const cloudflare = parseIPAddress(header('CF-Connecting-IP'))
    if (cloudflare) return cloudflare.normalized

    // Visitors can prepend their own entries: use the last address that is not our proxy
    const forwardedFor = header('X-Forwarded-For')
    if (forwardedFor) {
      const chain = forwardedFor
        .split(',')
        .map((entry) => parseIPAddress(entry.trim()))
        .filter((entry) => entry !== null)
      const visitor = [...chain].reverse().find((entry) => !isTrustedProxy(entry, options.rules)) ?? chain[0]
      if (visitor) return visitor.normalized
    }
  }

  return remoteAddress?.normalized || 'unknown'
}

/** Address of the TCP peer; Bun loses it once the response is sent */
export function getRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    return undefined
  }
}

/**
 * Get the IP address of the client
 * @param c Context containing request and response information
 * @returns The IP address as a string
 */
export function getIP(c: Context): string {
  try {
    return resolveClientIP(getRemoteAddress(c), (name) => c.req.header(name), { trustXForwardedFor: Config.trustXForwardedFor, rules: trustedProxyRules })
  } catch {
    return 'unknown'
  }
}

/** Requests through the Cloudflare tunnel carry CF-Connecting-IP; internal endpoints answer only the LAN */
export function isInternalRequest(c: Context): boolean {
  if (c.req.header('CF-Connecting-IP')) return false
  return isPrivateAddress(getRemoteAddress(c)) && isPrivateAddress(getIP(c))
}
