import './env'
import { describe, expect, test } from 'bun:test'

import { PRECONNECT_LINK, PRECONNECT_ORIGINS } from '../Server/Tools/Preconnect'

describe('Preconnect', () => {
  test('lists the API and image origins once, as bare origins', () => {
    expect(PRECONNECT_ORIGINS).toEqual(['https://api.example.test', 'https://images.example.test'])
  })

  test('the Link header carries the same origins', () => {
    expect(PRECONNECT_LINK).toBe('<https://api.example.test>; rel=preconnect, <https://images.example.test>; rel=preconnect')
  })
})
