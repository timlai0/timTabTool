import { describe, it, expect } from 'vitest'
import {
  normalizeUrl,
  detectDuplicateTabs,
  getUrlVariantDifferences,
  parseUrlSegments,
  isTrackingParam,
  isSpaHashRoute,
  stripDefaultDocumentFromPath,
  calculateKeeperTabScore
} from '../src/shared/utils'

describe('isTrackingParam', () => {
  it('identifies standard, e-commerce, and social tracking parameters', () => {
    expect(isTrackingParam('utm_source')).toBe(true)
    expect(isTrackingParam('srsltid')).toBe(true)
    expect(isTrackingParam('rdt_cid')).toBe(true)
    expect(isTrackingParam('igsh')).toBe(true)
    expect(isTrackingParam('fbclid')).toBe(true)
    expect(isTrackingParam('gclid')).toBe(true)
    expect(isTrackingParam('aff_id')).toBe(true)
    expect(isTrackingParam('mc_eid')).toBe(true)
    expect(isTrackingParam('session_id')).toBe(true)
  })

  it('matches prefix-based tracking query parameters', () => {
    expect(isTrackingParam('utm_custom_tag')).toBe(true)
    expect(isTrackingParam('hsa_acc')).toBe(true)
    expect(isTrackingParam('ga_campaign')).toBe(true)
    expect(isTrackingParam('matomo_keyword')).toBe(true)
    expect(isTrackingParam('piwik_campaign')).toBe(true)
  })

  it('preserves non-tracking query parameters', () => {
    expect(isTrackingParam('q')).toBe(false)
    expect(isTrackingParam('id')).toBe(false)
    expect(isTrackingParam('search')).toBe(false)
    expect(isTrackingParam('tab')).toBe(false)
    expect(isTrackingParam('page')).toBe(false)
  })
})

describe('isSpaHashRoute', () => {
  it('identifies client-side hash routes', () => {
    expect(isSpaHashRoute('#/dashboard')).toBe(true)
    expect(isSpaHashRoute('#!/inbox')).toBe(true)
    expect(isSpaHashRoute('#/users/42/details')).toBe(true)
  })

  it('identifies section anchors and text fragments as non-SPA routes', () => {
    expect(isSpaHashRoute('#section-2')).toBe(false)
    expect(isSpaHashRoute('#overview')).toBe(false)
    expect(isSpaHashRoute('#top')).toBe(false)
    expect(isSpaHashRoute('#:~:text=example')).toBe(false)
    expect(isSpaHashRoute('#')).toBe(false)
    expect(isSpaHashRoute(undefined)).toBe(false)
  })
})

describe('stripDefaultDocumentFromPath', () => {
  it('removes index and default documents from paths', () => {
    expect(stripDefaultDocumentFromPath('/docs/index.html')).toEqual({ path: '/docs', strippedDoc: 'index.html' })
    expect(stripDefaultDocumentFromPath('/index.php')).toEqual({ path: '/', strippedDoc: 'index.php' })
    expect(stripDefaultDocumentFromPath('/portal/default.aspx')).toEqual({ path: '/portal', strippedDoc: 'default.aspx' })
  })

  it('preserves standard path structures', () => {
    expect(stripDefaultDocumentFromPath('/docs/guide')).toEqual({ path: '/docs/guide' })
    expect(stripDefaultDocumentFromPath('/')).toEqual({ path: '/' })
  })
})

describe('normalizeUrl', () => {
  it('strips standard tracking parameters', () => {
    const raw = 'https://example.com/page?utm_source=twitter&utm_medium=social&utm_campaign=launch&ref=123&keep_me=yes'
    const normalized = normalizeUrl(raw)
    expect(normalized).toBe('https://example.com/page?keep_me=yes')
  })

  it('strips modern ad and affiliate parameters like srsltid and rdt_cid', () => {
    const raw = 'https://store.com/item?id=99&srsltid=AR5789&rdt_cid=12345&keep=1'
    const normalized = normalizeUrl(raw)
    expect(normalized).toBe('https://store.com/item?id=99&keep=1')
  })

  it('strips hash fragments by default for section anchors', () => {
    const raw = 'https://example.com/docs#section-2'
    const normalized = normalizeUrl(raw)
    expect(normalized).toBe('https://example.com/docs')
  })

  it('preserves SPA hash routes by default to avoid false positive page collisions', () => {
    const rawDashboard = 'https://app.example.com/#/dashboard'
    const rawBilling = 'https://app.example.com/#/billing'
    expect(normalizeUrl(rawDashboard)).toBe('https://app.example.com/#/dashboard')
    expect(normalizeUrl(rawBilling)).toBe('https://app.example.com/#/billing')
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

  it('normalizes www prefix when stripWww is true', () => {
    const raw = 'https://www.example.com/dashboard'
    const normalized = normalizeUrl(raw, { stripWww: true })
    expect(normalized).toBe('https://example.com/dashboard')
  })

  it('normalizes protocol when normalizeProtocol is true', () => {
    const raw = 'http://example.com/dashboard'
    const normalized = normalizeUrl(raw, { normalizeProtocol: true })
    expect(normalized).toBe('https://example.com/dashboard')
  })

  it('strips default index documents when stripDefaultDocument is true', () => {
    const raw = 'https://example.com/docs/index.html'
    const normalized = normalizeUrl(raw, { stripDefaultDocument: true })
    expect(normalized).toBe('https://example.com/docs')
  })
})

describe('parseUrlSegments', () => {
  it('correctly breaks URL into protocol, subdomain, domain, pathname, search, and hash', () => {
    const raw = 'https://www.goofish.com/item?id=123456#section-2'
    const segments = parseUrlSegments(raw)
    expect(segments.protocol).toBe('https://')
    expect(segments.subdomainPrefix).toBe('www.')
    expect(segments.domain).toBe('goofish.com')
    expect(segments.pathname).toBe('/item')
    expect(segments.search).toBe('?id=123456')
    expect(segments.hash).toBe('#section-2')
    expect(segments.searchParamsList).toEqual([{ key: 'id', value: '123456' }])
  })

  it('handles URLs without www or query parameters', () => {
    const raw = 'https://github.com/florianlanx/tabpilot'
    const segments = parseUrlSegments(raw)
    expect(segments.protocol).toBe('https://')
    expect(segments.subdomainPrefix).toBe('')
    expect(segments.domain).toBe('github.com')
    expect(segments.pathname).toBe('/florianlanx/tabpilot')
    expect(segments.search).toBe('')
    expect(segments.hash).toBe('')
  })
})

describe('getUrlVariantDifferences', () => {
  it('extracts stripped tracking parameters, hash, and human-readable reasons', () => {
    const raw = 'https://example.com/item?spm=a21ybx.item&utm_source=test#section-3'
    const diff = getUrlVariantDifferences(raw)
    expect(diff.strippedParams).toContain('spm')
    expect(diff.strippedParams).toContain('utm_source')
    expect(diff.hash).toBe('#section-3')
    expect(diff.trackingParamCount).toBe(2)
    expect(diff.reasons).toContain('+2 params')
    expect(diff.reasons).toContain('#section-3')
  })

  it('handles clean URLs without tracking params', () => {
    const raw = 'https://example.com/item?id=12345'
    const diff = getUrlVariantDifferences(raw)
    expect(diff.strippedParams).toEqual([])
    expect(diff.hash).toBeUndefined()
    expect(diff.trackingParamCount).toBe(0)
  })

  it('identifies protocol, www, and default doc differences against clean URL', () => {
    const raw = 'http://www.example.com/docs/index.html'
    const clean = 'https://example.com/docs'
    const diff = getUrlVariantDifferences(raw, clean)
    expect(diff.protocolDiff).toBe(true)
    expect(diff.wwwDiff).toBe(true)
    expect(diff.defaultDocDiff).toBe('index.html')
    expect(diff.reasons).toContain('http')
    expect(diff.reasons).toContain('www')
    expect(diff.reasons).toContain('index.html')
  })
})

describe('calculateKeeperTabScore', () => {
  it('prefers active tab over inactive tab', () => {
    const activeTab = { id: 1, url: 'https://example.com', active: true }
    const inactiveTab = { id: 2, url: 'https://example.com', active: false }
    expect(calculateKeeperTabScore(activeTab)).toBeGreaterThan(calculateKeeperTabScore(inactiveTab))
  })

  it('prefers pinned tab over unpinned tab', () => {
    const pinnedTab = { id: 1, url: 'https://example.com', pinned: true }
    const unpinnedTab = { id: 2, url: 'https://example.com', pinned: false }
    expect(calculateKeeperTabScore(pinnedTab)).toBeGreaterThan(calculateKeeperTabScore(unpinnedTab))
  })

  it('prefers audible media tab over silent tab', () => {
    const audibleTab = { id: 1, url: 'https://youtube.com/watch?v=123', audible: true }
    const silentTab = { id: 2, url: 'https://youtube.com/watch?v=123', audible: false }
    expect(calculateKeeperTabScore(audibleTab)).toBeGreaterThan(calculateKeeperTabScore(silentTab))
  })

  it('prefers tab inside a tab group over ungrouped tab', () => {
    const groupedTab = { id: 1, url: 'https://example.com', groupId: 101 }
    const ungroupedTab = { id: 2, url: 'https://example.com', groupId: -1 }
    expect(calculateKeeperTabScore(groupedTab)).toBeGreaterThan(calculateKeeperTabScore(ungroupedTab))
  })

  it('prefers clean canonical URL over URL with tracking noise', () => {
    const cleanUrl = 'https://example.com/item'
    const cleanTab = { id: 1, url: 'https://example.com/item' }
    const dirtyTab = { id: 2, url: 'https://example.com/item?utm_source=fb&gclid=123' }
    expect(calculateKeeperTabScore(cleanTab, cleanUrl)).toBeGreaterThan(calculateKeeperTabScore(dirtyTab, cleanUrl))
  })
})

describe('detectDuplicateTabs', () => {
  it('correctly categorizes exact duplicates vs tracking variant duplicates and includes cluster title', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/a', title: 'Exact 1', windowId: 1 },
      { id: 2, url: 'https://example.com/a', title: 'Exact 1 Copy', windowId: 1 },
      { id: 3, url: 'https://github.com/repo?utm_source=fb', title: 'GH Repo Title', windowId: 1 },
      { id: 4, url: 'https://github.com/repo?utm_source=tw', title: 'GH Repo Title Copy', windowId: 1 },
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
    expect(result.possibleDuplicates[0].title).toBe('GH Repo Title')
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

  it('detects protocol, www, and default document variants as possible duplicates', () => {
    const tabs = [
      { id: 20, url: 'http://example.com/article', title: 'HTTP Variant', windowId: 1 },
      { id: 21, url: 'https://example.com/article', title: 'HTTPS Variant', windowId: 1 },
      { id: 30, url: 'https://www.store.com/item', title: 'WWW Variant', windowId: 1 },
      { id: 31, url: 'https://store.com/item', title: 'Bare Domain', windowId: 1 },
      { id: 40, url: 'https://site.org/docs/index.html', title: 'Doc Variant', windowId: 1 },
      { id: 41, url: 'https://site.org/docs', title: 'Clean Path', windowId: 1 },
    ]

    const result = detectDuplicateTabs(tabs)
    expect(result.possibleDuplicates.length).toBe(3)
    expect(result.possibleDuplicateCount).toBe(3)
  })

  it('detects section anchor variants while protecting SPA routes from false duplicate clustering', () => {
    const tabs = [
      // Section anchors on same page -> should be clustered as possible duplicates
      { id: 50, url: 'https://docs.org/guide#intro', title: 'Intro', windowId: 1 },
      { id: 51, url: 'https://docs.org/guide#advanced', title: 'Advanced', windowId: 1 },
      // SPA hash routes -> should NOT be clustered together
      { id: 60, url: 'https://app.org/#/dashboard', title: 'App Dashboard', windowId: 1 },
      { id: 61, url: 'https://app.org/#/settings', title: 'App Settings', windowId: 1 },
    ]

    const result = detectDuplicateTabs(tabs)
    expect(result.possibleDuplicates.length).toBe(1)
    expect(result.possibleDuplicates[0].cleanUrl).toBe('https://docs.org/guide')
    expect(result.possibleDuplicates[0].tabs.map(t => t.id)).toEqual([50, 51])
  })

  it('correctly designates primaryTabId using keeper scoring in clusters', () => {
    const tabs = [
      { id: 70, url: 'https://site.com/p?utm_source=ad', title: 'Ad Link', windowId: 1, active: false },
      { id: 71, url: 'https://site.com/p', title: 'Canonical Page', windowId: 1, active: true },
    ]

    const result = detectDuplicateTabs(tabs)
    expect(result.possibleDuplicates.length).toBe(1)
    expect(result.possibleDuplicates[0].primaryTabId).toBe(71)
  })

  it('handles clusters containing both exact copies and variants without double-counting', () => {
    const tabs = [
      { id: 80, url: 'https://shop.com/item', title: 'Item Original', windowId: 1 },
      { id: 81, url: 'https://shop.com/item', title: 'Item Exact Copy', windowId: 1 },
      { id: 82, url: 'https://shop.com/item?utm_source=newsletter', title: 'Item Variant', windowId: 1 },
    ]

    const result = detectDuplicateTabs(tabs)
    // 1 exact duplicate (tab 81)
    expect(result.exactDuplicateCount).toBe(1)
    expect(result.exactDuplicates.map(t => t.id)).toEqual([81])

    // 1 variant duplicate (tab 82)
    expect(result.possibleDuplicateCount).toBe(1)
    expect(result.possibleDuplicates.length).toBe(1)
    expect(result.possibleDuplicates[0].exactCopiesCount).toBe(1)
    expect(result.possibleDuplicates[0].variantCopiesCount).toBe(1)

    // The tab 81 inside the cluster is flagged as exact copy
    const clusterTabs = result.possibleDuplicates[0].tabs
    const copyTab = clusterTabs.find(t => t.id === 81)
    expect(copyTab?.isExactDuplicate).toBe(true)
  })
})

