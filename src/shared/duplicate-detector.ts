'use strict';

import {
  extractDomain,
  normalizeUrl,
  isTrackingParam,
  isIgnoredSearchParam,
  isSpaHashRoute,
  DEFAULT_DOC_REGEX,
} from './url-utils'
import type { NormalizeUrlOptions } from './url-utils'

export interface MinimalTab {
  id?: number
  url?: string
  title?: string
  favIconUrl?: string
  windowId?: number
  active?: boolean
  pinned?: boolean
  audible?: boolean
  groupId?: number
  index?: number
  diff?: UrlVariantDiff
  isExactDuplicate?: boolean
}

export interface UrlVariantDiff {
  strippedParams: string[]
  hash?: string
  protocolDiff?: boolean
  wwwDiff?: boolean
  defaultDocDiff?: string
  trailingSlashDiff?: boolean
  trackingParamCount: number
  reasons: string[]
}

export interface PossibleDuplicateCluster {
  cleanUrl: string
  domain: string
  title?: string
  primaryTabId?: number
  matchReasons?: string[]
  exactCopiesCount?: number
  variantCopiesCount?: number
  tabs: MinimalTab[]
}

export interface DuplicateDetectionResult {
  exactDuplicateCount: number
  possibleDuplicateCount: number
  exactDuplicates: MinimalTab[]
  possibleDuplicates: PossibleDuplicateCluster[]
}

export interface DetectDuplicateOptions {
  stripWww?: boolean
  normalizeProtocol?: boolean
  stripDefaultDocument?: boolean
  removeHash?: boolean
  preserveSpaHashRoutes?: boolean
}

export const DEFAULT_DETECT_OPTIONS: DetectDuplicateOptions = {
  stripWww: true,
  normalizeProtocol: true,
  stripDefaultDocument: true,
  removeHash: true,
  preserveSpaHashRoutes: true,
}

export interface ParsedUrlSegments {
  protocol: string
  subdomainPrefix: string
  domain: string
  pathname: string
  search: string
  hash: string
  searchParamsList: Array<{ key: string; value: string }>
}

/**
 * Parses a URL into structured segments for visual highlighting and diffing.
 */
export function parseUrlSegments(urlString: string): ParsedUrlSegments {
  if (!urlString) {
    return {
      protocol: '',
      subdomainPrefix: '',
      domain: '',
      pathname: '',
      search: '',
      hash: '',
      searchParamsList: [],
    }
  }

  try {
    const url = new URL(urlString)
    const protocol = url.protocol ? `${url.protocol}//` : ''
    const fullHostname = url.hostname || ''

    let subdomainPrefix = ''
    let domain = fullHostname
    if (fullHostname.startsWith('www.')) {
      subdomainPrefix = 'www.'
      domain = fullHostname.slice(4)
    }

    const searchParamsList: Array<{ key: string; value: string }> = []
    url.searchParams.forEach((value, key) => {
      searchParamsList.push({ key, value })
    })

    const pathname = url.pathname === '/' && (url.search || url.hash) ? '/' : (url.pathname === '/' ? '' : url.pathname)

    return {
      protocol,
      subdomainPrefix,
      domain,
      pathname,
      search: url.search || '',
      hash: url.hash || '',
      searchParamsList,
    }
  } catch {
    return {
      protocol: '',
      subdomainPrefix: '',
      domain: '',
      pathname: urlString,
      search: '',
      hash: '',
      searchParamsList: [],
    }
  }
}

/**
 * Extracts stripped tracking parameters and hash differences from a raw URL.
 */
export function getUrlVariantDifferences(rawUrl: string, cleanUrl?: string): UrlVariantDiff {
  const strippedParams: string[] = []
  let hash: string | undefined
  let protocolDiff = false
  let wwwDiff = false
  let defaultDocDiff: string | undefined
  let trailingSlashDiff = false
  const reasons: string[] = []

  try {
    const raw = new URL(rawUrl)
    if (raw.hash && raw.hash !== '#' && !isSpaHashRoute(raw.hash)) {
      hash = raw.hash
      reasons.push(hash.length > 15 ? hash.slice(0, 14) + '…' : hash)
    }

    const clean = cleanUrl ? new URL(cleanUrl) : null
    raw.searchParams.forEach((_, key) => {
      if (isIgnoredSearchParam(key, raw) || (clean && !clean.searchParams.has(key))) {
        if (!strippedParams.includes(key)) {
          strippedParams.push(key)
        }
      }
    })

    if (strippedParams.length > 0) {
      reasons.unshift(`+${strippedParams.length} param${strippedParams.length > 1 ? 's' : ''}`)
    }

    if (clean) {
      if (raw.protocol !== clean.protocol) {
        protocolDiff = true
        reasons.push(raw.protocol.replace(':', ''))
      }
      if (raw.hostname.startsWith('www.') && !clean.hostname.startsWith('www.')) {
        wwwDiff = true
        reasons.push('www')
      }
      const rawDocMatch = raw.pathname.match(DEFAULT_DOC_REGEX)
      if (rawDocMatch && !clean.pathname.match(DEFAULT_DOC_REGEX)) {
        defaultDocDiff = rawDocMatch[1]
        reasons.push(rawDocMatch[1])
      }
      if (raw.pathname.endsWith('/') && !clean.pathname.endsWith('/') && raw.pathname.length > 1) {
        trailingSlashDiff = true
      }
    }
  } catch {
    // Ignore parse errors for invalid URLs
  }

  return {
    strippedParams,
    hash,
    protocolDiff,
    wwwDiff,
    defaultDocDiff,
    trailingSlashDiff,
    trackingParamCount: strippedParams.length,
    reasons,
  }
}

/**
 * Calculates a priority score to identify the optimal keeper tab within a duplicate cluster.
 */
export function calculateKeeperTabScore(tab: MinimalTab, cleanUrl?: string): number {
  let score = 0
  if (tab.active) score += 10000
  if (tab.pinned) score += 5000
  if (tab.audible) score += 3000
  if (typeof tab.groupId === 'number' && tab.groupId > 0) score += 1000

  if (tab.url) {
    if (cleanUrl && tab.url === cleanUrl) {
      score += 200
    } else {
      const diff = getUrlVariantDifferences(tab.url, cleanUrl)
      score -= diff.trackingParamCount * 10
      if (diff.hash && !isSpaHashRoute(diff.hash)) score -= 5
    }
  }

  if (tab.title && tab.title.trim() !== '' && tab.title !== 'Untitled' && !tab.title.startsWith('Loading')) {
    score += 50
  }

  if (typeof tab.index === 'number') {
    score -= tab.index * 0.01
  }

  return score
}

/**
 * Groups tabs by exact raw URL and canonical clean URL.
 */
export function groupTabsByUrl(
  tabs: MinimalTab[],
  options: DetectDuplicateOptions
): { urlSeen: Map<string, MinimalTab[]>; cleanUrlMap: Map<string, MinimalTab[]> } {
  const urlSeen = new Map<string, MinimalTab[]>()
  const cleanUrlMap = new Map<string, MinimalTab[]>()
  const cleanCache = new Map<string, string>()
  const seenTabIds = new Set<number>()

  let i = 0
  let tab: MinimalTab
  let exactList: MinimalTab[] | undefined
  let cleanUrl = ''
  let cleanList: MinimalTab[] | undefined

  for (i = 0; i < tabs.length; i++) {
    tab = tabs[i]
    if (!tab.url) continue
    if (typeof tab.id === 'number') {
      if (seenTabIds.has(tab.id)) continue
      seenTabIds.add(tab.id)
    }

    exactList = urlSeen.get(tab.url)
    if (!exactList) {
      exactList = []
      urlSeen.set(tab.url, exactList)
    }
    exactList.push(tab)

    cleanUrl = cleanCache.get(tab.url) || ''
    if (!cleanUrl) {
      cleanUrl = normalizeUrl(tab.url, options)
      cleanCache.set(tab.url, cleanUrl)
    }

    cleanList = cleanUrlMap.get(cleanUrl)
    if (!cleanList) {
      cleanList = []
      cleanUrlMap.set(cleanUrl, cleanList)
    }
    cleanList.push(tab)
  }

  return { urlSeen, cleanUrlMap }
}

/**
 * Extracts exact duplicate tabs from exact URL groupings.
 */
export function extractExactDuplicates(
  urlSeen: Map<string, MinimalTab[]>
): { exactDuplicates: MinimalTab[]; exactDuplicateCount: number; exactDupIdSet: Set<number> } {
  const exactDuplicates: MinimalTab[] = []
  const exactDupIdSet = new Set<number>()
  let exactDuplicateCount = 0
  let group: MinimalTab[]
  let j = 0
  let t: MinimalTab

  for (group of urlSeen.values()) {
    if (group.length > 1) {
      exactDuplicateCount += group.length - 1
      for (j = 1; j < group.length; j++) {
        t = group[j]
        exactDuplicates.push(t)
        if (typeof t.id === 'number') {
          exactDupIdSet.add(t.id)
        }
      }
    }
  }

  return { exactDuplicates, exactDuplicateCount, exactDupIdSet }
}

/**
 * Aggregates distinct reasons why tabs in the cluster differ from canonical form.
 */
export function buildClusterMatchReasons(tabs: MinimalTab[]): string[] {
  const reasons = new Set<string>()
  let k = 0
  let diff: UrlVariantDiff | undefined

  for (k = 0; k < tabs.length; k++) {
    diff = tabs[k].diff
    if (!diff) continue
    if (diff.trackingParamCount > 0) reasons.add('tracking_params')
    if (diff.hash) reasons.add('hash_fragment')
    if (diff.protocolDiff) reasons.add('protocol')
    if (diff.wwwDiff) reasons.add('subdomain_www')
    if (diff.defaultDocDiff) reasons.add('default_doc')
    if (diff.trailingSlashDiff) reasons.add('trailing_slash')
  }

  return Array.from(reasons)
}

/**
 * Builds cluster objects for canonical URL groupings that contain variant duplicates.
 */
export function buildPossibleDuplicateClusters(
  cleanUrlMap: Map<string, MinimalTab[]>,
  exactDupIdSet: Set<number>
): { possibleDuplicates: PossibleDuplicateCluster[]; possibleDuplicateCount: number } {
  const possibleDuplicates: PossibleDuplicateCluster[] = []
  let possibleDuplicateCount = 0

  let cleanUrl = ''
  let group: MinimalTab[]
  let uniqueExactUrls: Set<string>
  let keeperTab: MinimalTab
  let primaryTabId: number | undefined
  let bestScore = -Infinity
  let score = 0
  let tab: MinimalTab
  let k = 0
  let domain = ''
  let representativeTitle = ''
  let exactInCluster = 0
  let variantsInCluster = 0
  let diff: UrlVariantDiff

  for (const entry of cleanUrlMap.entries()) {
    cleanUrl = entry[0]
    group = entry[1]
    if (group.length < 2) continue

    uniqueExactUrls = new Set()
    for (k = 0; k < group.length; k++) {
      if (group[k].url) uniqueExactUrls.add(group[k].url!)
    }
    if (uniqueExactUrls.size <= 1) continue

    bestScore = -Infinity
    keeperTab = group[0]
    for (k = 0; k < group.length; k++) {
      score = calculateKeeperTabScore(group[k], cleanUrl)
      if (score > bestScore) {
        bestScore = score
        keeperTab = group[k]
      }
    }
    primaryTabId = keeperTab.id

    exactInCluster = 0
    variantsInCluster = 0
    for (k = 0; k < group.length; k++) {
      tab = group[k]
      diff = getUrlVariantDifferences(tab.url || '', cleanUrl)
      tab.diff = diff
      if (tab.id !== primaryTabId) {
        if (tab.url === keeperTab.url) {
          tab.isExactDuplicate = true
          exactInCluster++
        } else {
          variantsInCluster++
          possibleDuplicateCount++
        }
      }
    }

    domain = extractDomain(cleanUrl) || (group[0].url ? extractDomain(group[0].url) : 'unknown')
    representativeTitle = group.find(t => t.title && t.title.trim() !== '' && t.title !== 'Untitled')?.title || group[0].title || ''

    possibleDuplicates.push({
      cleanUrl,
      domain,
      title: representativeTitle,
      primaryTabId,
      exactCopiesCount: exactInCluster,
      variantCopiesCount: variantsInCluster,
      matchReasons: buildClusterMatchReasons(group),
      tabs: group,
    })
  }

  return { possibleDuplicates, possibleDuplicateCount }
}

/**
 * Detects exact and possible duplicate tabs across browser windows.
 */
export function detectDuplicateTabs(tabs: MinimalTab[], options?: DetectDuplicateOptions): DuplicateDetectionResult {
  const opts = { ...DEFAULT_DETECT_OPTIONS, ...options }
  const { urlSeen, cleanUrlMap } = groupTabsByUrl(tabs, opts)
  const { exactDuplicates, exactDuplicateCount, exactDupIdSet } = extractExactDuplicates(urlSeen)
  const { possibleDuplicates, possibleDuplicateCount } = buildPossibleDuplicateClusters(cleanUrlMap, exactDupIdSet)

  return {
    exactDuplicateCount,
    possibleDuplicateCount,
    exactDuplicates,
    possibleDuplicates,
  }
}
