import './env'
import { describe, expect, test } from 'bun:test'

import { resolveClientIP } from '../Server/Tools/ClientIP'
import { isLoopbackAddress, isPrivateAddress, isTrustedProxy, loadTrustedProxies, parseIPAddress } from '../Server/Tools/TrustedProxy'

const headers = (values: Record<string, string>) => (name: string) => values[name]
const rules = loadTrustedProxies(['172.16.0.0/12', '127.0.0.1'])
const trusting = { trustXForwardedFor: true, rules }

describe('parseIPAddress', () => {
  test('IPv4, bracketed and mapped IPv6, zones', () => {
    expect(parseIPAddress('10.0.0.1')?.family).toBe(4)
    expect(parseIPAddress('[::1]')?.normalized).toBe('::1')
    expect(parseIPAddress('::ffff:192.168.1.5')?.normalized).toBe('192.168.1.5')
    expect(parseIPAddress('fe80::1%eth0')?.normalized).toBe('fe80::1')
  })

  test('rejects garbage', () => {
    expect(parseIPAddress('256.1.1.1')).toBeNull()
    expect(parseIPAddress('1.2.3')).toBeNull()
    expect(parseIPAddress('1::2::3')).toBeNull()
    expect(parseIPAddress('')).toBeNull()
  })
})

describe('trusted proxies', () => {
  test('CIDR and single addresses', () => {
    expect(isTrustedProxy(parseIPAddress('172.18.0.5')!, rules)).toBe(true)
    expect(isTrustedProxy(parseIPAddress('172.32.0.5')!, rules)).toBe(false)
    expect(isTrustedProxy(parseIPAddress('127.0.0.1')!, rules)).toBe(true)
  })

  test('invalid entries are reported and skipped', () => {
    const invalid: string[] = []
    const loaded = loadTrustedProxies(['10.0.0.0/33', 'nope', '10.0.0.0/8'], (entry) => invalid.push(entry))
    expect(loaded).toHaveLength(1)
    expect(invalid).toEqual(['10.0.0.0/33', 'nope'])
  })

  test('loopback and private ranges', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.2')).toBe(false)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('192.168.0.1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2001:db8::1')).toBe(false)
  })
})

describe('resolveClientIP', () => {
  test('the peer address when forwarding headers are not trusted', () => {
    expect(resolveClientIP('172.18.0.2', headers({ 'CF-Connecting-IP': '1.1.1.1' }), { trustXForwardedFor: false, rules })).toBe('172.18.0.2')
  })

  test('an untrusted peer cannot name the client', () => {
    expect(resolveClientIP('8.8.8.8', headers({ 'CF-Connecting-IP': '1.1.1.1', 'X-Forwarded-For': '2.2.2.2' }), trusting)).toBe('8.8.8.8')
  })

  test('CF-Connecting-IP from a trusted proxy wins', () => {
    expect(resolveClientIP('172.18.0.2', headers({ 'CF-Connecting-IP': '1.1.1.1', 'X-Forwarded-For': '2.2.2.2' }), trusting)).toBe('1.1.1.1')
  })

  test('the last untrusted X-Forwarded-For entry, so a prepended one is ignored', () => {
    expect(resolveClientIP('172.18.0.2', headers({ 'X-Forwarded-For': '6.6.6.6, 3.3.3.3, 172.18.0.9' }), trusting)).toBe('3.3.3.3')
  })

  test('a chain of trusted addresses falls back to its first entry', () => {
    expect(resolveClientIP('172.18.0.2', headers({ 'X-Forwarded-For': '172.20.0.1, 172.18.0.9' }), trusting)).toBe('172.20.0.1')
  })

  test('unparseable values', () => {
    expect(resolveClientIP(undefined, headers({}), trusting)).toBe('unknown')
    expect(resolveClientIP('172.18.0.2', headers({ 'CF-Connecting-IP': 'evil', 'X-Forwarded-For': 'junk' }), trusting)).toBe('172.18.0.2')
  })
})
