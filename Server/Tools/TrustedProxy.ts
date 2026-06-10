export type ParsedIPAddress = {
  family: 4 | 6
  normalized: string
  value: bigint
}

export type TrustedProxyRule = {
  family: 4 | 6
  prefix: number
  network: bigint
}

export function loadTrustedProxies(
  entries: string[],
  onInvalidEntry?: (entry: string, reason: string) => void
): TrustedProxyRule[] {
  const rules: TrustedProxyRule[] = []

  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }

    try {
      if (trimmed.includes('/')) {
        const [rawAddress, rawPrefix] = trimmed.split('/', 2)
        const address = parseIPAddress(rawAddress)
        const prefix = Number.parseInt(rawPrefix, 10)
        const maxPrefix = address?.family === 4 ? 32 : 128

        if (!address || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
          throw new Error('invalid CIDR entry')
        }

        rules.push({
          family: address.family,
          prefix,
          network: applyCIDRMask(address.value, address.family, prefix),
        })
      } else {
        const address = parseIPAddress(trimmed)

        if (!address) {
          throw new Error('invalid IP entry')
        }

        rules.push({
          family: address.family,
          prefix: address.family === 4 ? 32 : 128,
          network: address.value,
        })
      }
    } catch (error) {
      onInvalidEntry?.(trimmed, error instanceof Error ? error.message : String(error))
    }
  }

  return rules
}

export function isTrustedProxy(address: ParsedIPAddress, rules: TrustedProxyRule[]): boolean {
  return rules.some((rule) => {
    if (rule.family !== address.family) {
      return false
    }

    return applyCIDRMask(address.value, address.family, rule.prefix) === rule.network
  })
}

export function isLoopbackAddress(value: string | ParsedIPAddress | undefined | null): boolean {
  const address = typeof value === 'string'
    ? parseIPAddress(value)
    : value

  if (!address) {
    return false
  }

  if (address.family === 4) {
    return address.normalized === '127.0.0.1'
  }

  return address.normalized === '::1'
}

export function parseIPAddress(value: string | undefined | null): ParsedIPAddress | null {
  if (!value) {
    return null
  }

  let normalized = value.trim()
  if (!normalized) {
    return null
  }

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }

  const zoneIndex = normalized.indexOf('%')
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex)
  }

  const mappedIPv4Match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mappedIPv4Match) {
    normalized = mappedIPv4Match[1]
  }

  const ipv4Value = parseIPv4Address(normalized)
  if (ipv4Value !== null) {
    return {
      family: 4,
      normalized,
      value: ipv4Value,
    }
  }

  const ipv6Value = parseIPv6Address(normalized)
  if (ipv6Value !== null) {
    return {
      family: 6,
      normalized: normalized.toLowerCase(),
      value: ipv6Value,
    }
  }

  return null
}

function parseIPv4Address(value: string): bigint | null {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return null
  }

  let result = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }

    const octet = Number.parseInt(part, 10)
    if (octet < 0 || octet > 255) {
      return null
    }

    result = (result << 8n) | BigInt(octet)
  }

  return result
}

function parseIPv6Address(value: string): bigint | null {
  const doubleColonParts = value.split('::')
  if (doubleColonParts.length > 2) {
    return null
  }

  const left = parseIPv6Side(doubleColonParts[0] || '')
  const right = parseIPv6Side(doubleColonParts.length === 2 ? doubleColonParts[1] || '' : '')

  if (left === null || right === null) {
    return null
  }

  let groups: number[]
  if (doubleColonParts.length === 2) {
    const missing = 8 - (left.length + right.length)
    if (missing < 1) {
      return null
    }
    groups = [...left, ...new Array(missing).fill(0), ...right]
  } else {
    groups = left
    if (groups.length !== 8) {
      return null
    }
  }

  if (groups.length !== 8) {
    return null
  }

  let result = 0n
  for (const group of groups) {
    result = (result << 16n) | BigInt(group)
  }

  return result
}

function parseIPv6Side(side: string): number[] | null {
  if (!side) {
    return []
  }

  const tokens = side.split(':')
  const groups: number[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) {
      return null
    }

    if (token.includes('.')) {
      if (i !== tokens.length - 1) {
        return null
      }

      const ipv4 = parseIPv4Address(token)
      if (ipv4 === null) {
        return null
      }

      groups.push(Number((ipv4 >> 16n) & 0xffffn))
      groups.push(Number(ipv4 & 0xffffn))
      continue
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) {
      return null
    }

    groups.push(Number.parseInt(token, 16))
  }

  return groups
}

function applyCIDRMask(value: bigint, family: 4 | 6, prefix: number): bigint {
  const bits = family === 4 ? 32 : 128
  if (prefix <= 0) {
    return 0n
  }
  if (prefix >= bits) {
    return value
  }

  const hostBits = BigInt(bits - prefix)
  return (value >> hostBits) << hostBits
}
