import './env'
import { describe, expect, test } from 'bun:test'

import Config, { numberEnv, oneOfEnv, parseBooleanEnv, parseListEnv, requireURL } from '../Config'

describe('Config', () => {
  test('loads with the test environment', () => {
    expect(Config.apiHost).toBe('https://api.example.test')
    expect(Config.shutdownBudgetMs).toBe(Config.drainTimeoutMs + 25000)
  })

  test('numbers: default when unset, the value when valid', () => {
    expect(numberEnv('X', 7, {}, {})).toBe(7)
    expect(numberEnv('X', 7, {}, { X: '  ' })).toBe(7)
    expect(numberEnv('X', 7, {}, { X: '2.5' })).toBe(2.5)
    expect(numberEnv('X', 7, { integer: true, min: 0 }, { X: '0' })).toBe(0)
  })

  test('numbers: a bad value names the variable', () => {
    expect(() => numberEnv('RATE_LIMIT', 10, {}, { RATE_LIMIT: '1O' })).toThrow('RATE_LIMIT must be a number')
    expect(() => numberEnv('PORT', 3000, { integer: true }, { PORT: '30.5' })).toThrow('PORT must be a whole number')
    expect(() => numberEnv('ARCHIVE_MAX_GB', 0, { min: 0 }, { ARCHIVE_MAX_GB: '-1' })).toThrow('ARCHIVE_MAX_GB must be at least 0')
    expect(() => numberEnv('PORT', 3000, { max: 65535 }, { PORT: '70000' })).toThrow('PORT must be at most 65535')
    expect(() => numberEnv('X', 1, {}, { X: 'Infinity' })).toThrow('X must be a number')
  })

  test('URLs must be absolute and lose trailing slashes', () => {
    expect(requireURL('API_URL', { API_URL: 'https://a.test/' })).toBe('https://a.test')
    expect(() => requireURL('API_URL', {})).toThrow('API_URL is not set')
    expect(() => requireURL('IMAGE_URL', { IMAGE_URL: '/images' })).toThrow('IMAGE_URL must be an absolute URL')
  })

  test('booleans, lists and choices', () => {
    expect(parseBooleanEnv('Yes')).toBe(true)
    expect(parseBooleanEnv('0')).toBe(false)
    expect(parseBooleanEnv(undefined)).toBe(false)
    expect(parseListEnv(' 10.0.0.0/8, ,::1 ')).toEqual(['10.0.0.0/8', '::1'])
    expect(oneOfEnv('LOG_FORMAT', ['text', 'json'] as const, 'text', { LOG_FORMAT: 'JSON' })).toBe('json')
    expect(() => oneOfEnv('LOG_FORMAT', ['text', 'json'] as const, 'text', { LOG_FORMAT: 'xml' })).toThrow('LOG_FORMAT must be one of text, json')
  })
})
