import { describe, it, expect } from 'vitest'
import { normalizeUrl, detectDuplicateTabs } from '../src/shared/utils'

describe('normalizeUrl', () => {
  it('strips standard tracking parameters', () => {
    const raw = 'https://example.com/page?utm_source=twitter&utm_medium=social&utm_campaign=launch&ref=123&keep_me=yes'
    const normalized = normalizeUrl(raw)
    expect(normalized).toBe('https://example.com/page?keep_me=yes')
  })

  it('strips hash fragments by default', () => {
    const raw = 'https://example.com/docs#section-2'
    const normalized = normalizeUrl(raw)
    expect(normalized).toBe('https://example.com/docs')
  })

  it('preserves hash fragments when removeHash is false', () => {
    const raw = 'https://example.com/docs#section-2'
    const normalized = normalizeUrl(raw, { removeHash: false })
    expect(normalized).toBe('https://example.com/docs#section-2')
  })

  it('sorts search parameters deterministically', () => {
    const url1 = 'https://example.com/item?z=2&a=1&m=3'
    const url2 = 'https://example.com/item?a=1&m=3&z=2'
    expect(normalizeUrl(url1)).toBe(normalizeUrl(url2))
    expect(normalizeUrl(url1)).toBe('https://example.com/item?a=1&m=3&z=2')
  })

  it('normalizes trailing slashes on path', () => {
    const raw = 'https://example.com/dashboard/'
    const normalized = normalizeUrl(raw)
    expect(normalized).toBe('https://example.com/dashboard')
  })
})

describe('detectDuplicateTabs', () => {
  it('correctly categorizes exact duplicates vs tracking variant duplicates', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/a', title: 'Exact 1', windowId: 1 },
      { id: 2, url: 'https://example.com/a', title: 'Exact 1 Copy', windowId: 1 },
      { id: 3, url: 'https://github.com/repo?utm_source=fb', title: 'GH 1', windowId: 1 },
      { id: 4, url: 'https://github.com/repo?utm_source=tw', title: 'GH 2', windowId: 1 },
      { id: 5, url: 'https://unique.org/page', title: 'Unique', windowId: 1 },
    ]

    const result = detectDuplicateTabs(tabs)

    // Exact duplicates: tab #2
    expect(result.exactDuplicateCount).toBe(1)
    expect(result.exactDuplicates.map(t => t.id)).toEqual([2])

    // Possible duplicates: tabs #3 and #4 (same clean URL, different tracking params)
    expect(result.possibleDuplicateCount).toBe(1)
    expect(result.possibleDuplicates.length).toBe(1)
    expect(result.possibleDuplicates[0].cleanUrl).toBe('https://github.com/repo')
    expect(result.possibleDuplicates[0].tabs.map(t => t.id)).toEqual([3, 4])
  })

  it('returns 0 possible duplicates when all duplicates are exact duplicates', () => {
    const tabs = [
      { id: 10, url: 'https://example.com/test', title: 'Test', windowId: 1 },
      { id: 11, url: 'https://example.com/test', title: 'Test Copy', windowId: 1 },
    ]

    const result = detectDuplicateTabs(tabs)
    expect(result.exactDuplicateCount).toBe(1)
    expect(result.possibleDuplicateCount).toBe(0)
    expect(result.possibleDuplicates).toEqual([])
  })
})
