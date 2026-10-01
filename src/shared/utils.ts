/**
 * Extracts the domain from a URL.
 * @param {string | undefined} url
 * @returns {string}
 */
export function extractDomain(url: string | undefined): string {
  // Logic: Extract hostname using regex
  if (!url) return ''
  const match = url.match(/^https?:\/\/(?:www\.)?([^\/]+)/i)
  return match ? match[1] : ''
}

/**
 * Calculates automatic batch size based on max tokens.
 * @param {number | undefined} maxTokens
 * @returns {number}
 */
export function getAutoBatchSize(maxTokens: number | undefined): number {
  // Logic: Scale batch size down for lower token limits, capped at 100
  const tokens = maxTokens || 16384
  return Math.min(100, Math.max(10, Math.floor(tokens / 500)))
}

/**
 * Parses max token string (like 16K) to a number.
 * @param {string | number | undefined} maxTokensStr
 * @returns {number}
 */
export function parseMaxTokensToNumber(maxTokensStr: string | number | undefined): number {
  // Logic: Convert strings with K suffix to raw numbers
  if (typeof maxTokensStr === 'number') return maxTokensStr
  if (!maxTokensStr) return 16384
  const str = String(maxTokensStr).trim().toUpperCase()
  if (str.endsWith('K')) {
    const val = parseFloat(str.replace('K', ''))
    if (!isNaN(val)) return Math.round(val * 1024)
  }
  const num = parseInt(str, 10)
  return isNaN(num) ? 16384 : num
}

/**
 * Gets the optimal favicon URL, preferring Google favicon service.
 * @param {string} urlStr
 * @param {string} [fallbackFavIconUrl]
 * @returns {string}
 */
export function getOptimalFaviconUrl(urlStr: string, fallbackFavIconUrl?: string): string {
  // Logic: Try browser native favicon, fallback to Google S2
  if (!urlStr) return fallbackFavIconUrl || ''
  try {
    const urlObj = new URL(urlStr)
    const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
    
    if (!isFirefox && typeof chrome !== 'undefined' && chrome.runtime?.id) {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(urlObj.href)}&size=16`
    }
    
    // Firefox specific or non-extension fallback logic
    if (fallbackFavIconUrl) {
      let isLocalFavicon = false
      try {
        const hostname = new URL(fallbackFavIconUrl).hostname
        isLocalFavicon = hostname === 'localhost' || 
                         hostname === '127.0.0.1' || 
                         hostname.startsWith('192.168.') || 
                         hostname.startsWith('10.') || 
                         /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
                         hostname.endsWith('.local')
      } catch {
        // Ignore URL parsing errors
      }
      
      const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'
      const isHttpFavicon = fallbackFavIconUrl.startsWith('http://')
      
      if (!(isHttps && isHttpFavicon) && !isLocalFavicon) {
        return fallbackFavIconUrl
      }
    }
    
    if (!urlObj.hostname) return fallbackFavIconUrl || ''
    return `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(urlObj.hostname)}`
  } catch {
    return fallbackFavIconUrl || ''
  }
}

/**
 * Formats a timestamp into a relative time string.
 * @param {number} timestamp
 * @param {number} [now]
 * @returns {string}
 */
export function formatTimeAgo(timestamp: number, now = Date.now()): string {
  // Logic: Calculate diff and format as just now, mins, hours, or days
  const diffMs = Math.max(0, now - timestamp)
  const diffSecs = Math.floor(diffMs / 1000)
  if (diffSecs < 60) {
    return 'just now'
  }
  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) {
    return `${diffMins}m ago`
  }
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic', 'utm_name',
  'fbclid', 'gclid', 'gbraid', 'wbraid', '_gl', 'msclkid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', 'feature', 'si', 'igshid', 'igsh', 'fb_action_ids', 'fb_action_types', 'fb_source', 'fb_ref', 'mibextid',
  'twclid', 'ttclid', 'yclid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking', '_openstat', 'gad_source',
  'spm', 'spm_id_from', 'scm', 'pvid', 'algo_pvid', 'algo_exp_id', 'btsid', 'ws_ab_test',
  'origin', 'vd_source', 'callback', '_t', 'from_source', 'from', 'is_from_webapp',
  'sender_device', 'refer', 'bd_vid', 'kwd', 'search_id', 'cmpid', 'via', 's_kwcid', 'dclid', 'zanpid',
  'srsltid', 'rdt_cid', 'share_id', 'li_fat_id', 'tt_medium', 'tt_content', 'is_copy_url',
  'pk_campaign', 'pk_kwd', 'matomo_campaign', 'matomo_keyword', 'piwik_campaign', 'piwik_kwd', 'wt_mc', 'vgo_ee',
  'aff_id', 'aff_sub', 'affiliate_id', 'click_id', 'subid', 'campaign_id',
  'session_id', 'phpsessid', 'jsessionid', 'asid', 'ab_channel', 'ref_src', 'ref_url'
])

const DEFAULT_DOC_REGEX = /\/(index\.(html?|php)|default\.aspx?)$/i

/**
 * Checks if a parameter key is an analytics/tracking tag or click identifier.
 * @param {string} key
 * @returns {boolean}
 */
export function isTrackingParam(key: string): boolean {
  // Logic: Identify advertising, referral, and analytics query parameters
  const lower = key.toLowerCase()
  if (TRACKING_PARAMS.has(lower)) return true
  return (
    lower.startsWith('utm_') ||
    lower.startsWith('hsa_') ||
    lower.startsWith('ga_') ||
    lower.startsWith('fb_') ||
    lower.startsWith('mc_') ||
    lower.startsWith('pk_') ||
    lower.startsWith('matomo_') ||
    lower.startsWith('piwik_')
  )
}

/**
 * Checks if a hash string represents a client-side SPA route rather than a section anchor.
 * @param {string | undefined} hash
 * @returns {boolean}
 */
export function isSpaHashRoute(hash: string | undefined): boolean {
  // Logic: SPA hash routes begin with #/ or #!/
  if (!hash) return false
  return hash.startsWith('#/') || hash.startsWith('#!/')
}

/**
 * Strips default index documents from URL pathname.
 * @param {string} pathname
 * @returns {{ path: string; strippedDoc?: string }}
 */
export function stripDefaultDocumentFromPath(pathname: string): { path: string; strippedDoc?: string } {
  // Logic: Remove index.html, index.php, default.aspx from pathname
  const match = pathname.match(DEFAULT_DOC_REGEX)
  if (match) {
    const stripped = pathname.replace(DEFAULT_DOC_REGEX, '')
    return { path: stripped === '' ? '/' : stripped, strippedDoc: match[1] }
  }
  return { path: pathname }
}

/**
 * Cleans tracking query parameters and sorts parameters deterministically.
 * @param {URL} url
 * @returns {{ strippedParams: string[] }}
 */
export function cleanUrlSearchParams(url: URL): { strippedParams: string[] } {
  // Logic: Remove marketing parameters and sort query string
  const keysToDelete: string[] = []
  url.searchParams.forEach((_, key) => {
    if (isTrackingParam(key)) {
      keysToDelete.push(key)
    }
  })

  let delKey = ''
  for (let i = 0; i < keysToDelete.length; i++) {
    delKey = keysToDelete[i]
    url.searchParams.delete(delKey)
  }

  url.searchParams.sort()
  return { strippedParams: keysToDelete }
}

export interface NormalizeUrlOptions {
  removeHash?: boolean
  preserveSpaHashRoutes?: boolean
  stripWww?: boolean
  normalizeProtocol?: boolean
  stripDefaultDocument?: boolean
}

/**
 * Normalizes a URL by stripping tracking parameters, protocol variants, and default documents.
 * @param {string} urlString
 * @param {NormalizeUrlOptions} [options]
 * @returns {string}
 */
export function normalizeUrl(urlString: string, options: NormalizeUrlOptions = {}): string {
  // Logic: Canonicalize URL by stripping tracking parameters, protocol, host, and index documents
  if (!urlString) return ''
  try {
    const url = new URL(urlString)

    if (options.normalizeProtocol && (url.protocol === 'http:' || url.protocol === 'https:')) {
      const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
      if (!isLocal) url.protocol = 'https:'
    }

    url.hostname = url.hostname.toLowerCase()
    if (options.stripWww && url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4)
    }

    if (options.stripDefaultDocument) {
      url.pathname = stripDefaultDocumentFromPath(url.pathname).path
    }

    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }

    cleanUrlSearchParams(url)

    if (options.removeHash !== false) {
      if (options.preserveSpaHashRoutes !== false && isSpaHashRoute(url.hash)) {
        // Programming logic: Preserve client-side SPA routing hash
      } else {
        url.hash = ''
      }
    }

    return url.toString()
  } catch {
    return urlString.trim()
  }
}

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
  preserveSpaHashRoutes: true
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
 * @param {string} urlString
 * @returns {ParsedUrlSegments}
 */
export function parseUrlSegments(urlString: string): ParsedUrlSegments {
  // Logic: Split URL into protocol, subdomain, domain, pathname, search params and hash
  if (!urlString) {
    return {
      protocol: '',
      subdomainPrefix: '',
      domain: '',
      pathname: '',
      search: '',
      hash: '',
      searchParamsList: []
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
      searchParamsList
    }
  } catch {
    return {
      protocol: '',
      subdomainPrefix: '',
      domain: '',
      pathname: urlString,
      search: '',
      hash: '',
      searchParamsList: []
    }
  }
}

/**
 * Extracts stripped tracking parameters and hash differences from a raw URL.
 * @param {string} rawUrl
 * @param {string} [cleanUrl]
 * @returns {UrlVariantDiff}
 */
export function getUrlVariantDifferences(rawUrl: string, cleanUrl?: string): UrlVariantDiff {
  // Logic: Identify stripped tracking query parameters, hash differences, protocol, and host differences
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

    raw.searchParams.forEach((_, key) => {
      if (isTrackingParam(key)) {
        strippedParams.push(key)
      }
    })

    if (strippedParams.length > 0) {
      reasons.unshift(`+${strippedParams.length} param${strippedParams.length > 1 ? 's' : ''}`)
    }

    if (cleanUrl) {
      const clean = new URL(cleanUrl)
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
    reasons
  }
}

/**
 * Calculates a priority score to identify the optimal keeper tab within a duplicate cluster.
 * @param {MinimalTab} tab
 * @param {string} [cleanUrl]
 * @returns {number}
 */
export function calculateKeeperTabScore(tab: MinimalTab, cleanUrl?: string): number {
  // Logic: Score tab candidates based on active status, pinned status, audio, and URL cleanliness
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
 * @param {MinimalTab[]} tabs
 * @param {DetectDuplicateOptions} options
 * @returns {{ urlSeen: Map<string, MinimalTab[]>; cleanUrlMap: Map<string, MinimalTab[]> }}
 */
export function groupTabsByUrl(
  tabs: MinimalTab[],
  options: DetectDuplicateOptions
): { urlSeen: Map<string, MinimalTab[]>; cleanUrlMap: Map<string, MinimalTab[]> } {
  // Logic: Group tabs into exact matching and canonical clean URL collections
  const urlSeen = new Map<string, MinimalTab[]>()
  const cleanUrlMap = new Map<string, MinimalTab[]>()
  const cleanCache = new Map<string, string>()

  let i = 0
  let tab: MinimalTab
  let exactList: MinimalTab[] | undefined
  let cleanUrl = ''
  let cleanList: MinimalTab[] | undefined

  for (i = 0; i < tabs.length; i++) {
    tab = tabs[i]
    if (!tab.url) continue

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
 * @param {Map<string, MinimalTab[]>} urlSeen
 * @returns {{ exactDuplicates: MinimalTab[]; exactDuplicateCount: number; exactDupIdSet: Set<number> }}
 */
export function extractExactDuplicates(
  urlSeen: Map<string, MinimalTab[]>
): { exactDuplicates: MinimalTab[]; exactDuplicateCount: number; exactDupIdSet: Set<number> } {
  // Logic: Identify tabs with identical raw URLs beyond the primary instance
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
 * @param {MinimalTab[]} tabs
 * @returns {string[]}
 */
export function buildClusterMatchReasons(tabs: MinimalTab[]): string[] {
  // Logic: Extract match tags across all variant diffs
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
 * @param {Map<string, MinimalTab[]>} cleanUrlMap
 * @param {Set<number>} exactDupIdSet
 * @returns {{ possibleDuplicates: PossibleDuplicateCluster[]; possibleDuplicateCount: number }}
 */
export function buildPossibleDuplicateClusters(
  cleanUrlMap: Map<string, MinimalTab[]>,
  exactDupIdSet: Set<number>
): { possibleDuplicates: PossibleDuplicateCluster[]; possibleDuplicateCount: number } {
  // Logic: Construct clusters for clean URLs containing differing URL variants
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
      tabs: group
    })
  }

  return { possibleDuplicates, possibleDuplicateCount }
}

/**
 * Detects exact and possible duplicate tabs across browser windows.
 * @param {MinimalTab[]} tabs
 * @param {DetectDuplicateOptions} [options]
 * @returns {DuplicateDetectionResult}
 */
export function detectDuplicateTabs(tabs: MinimalTab[], options?: DetectDuplicateOptions): DuplicateDetectionResult {
  // Logic: Identify exact URL duplicates and canonical URL variant clusters
  const opts = { ...DEFAULT_DETECT_OPTIONS, ...options }
  const { urlSeen, cleanUrlMap } = groupTabsByUrl(tabs, opts)
  const { exactDuplicates, exactDuplicateCount, exactDupIdSet } = extractExactDuplicates(urlSeen)
  const { possibleDuplicates, possibleDuplicateCount } = buildPossibleDuplicateClusters(cleanUrlMap, exactDupIdSet)

  return {
    exactDuplicateCount,
    possibleDuplicateCount,
    exactDuplicates,
    possibleDuplicates
  }
}

/**
 * Extract clean JSON substring (array or object) from a raw string, handling markdown code blocks,
 * matching open/close bracket depth, and ignoring trailing non-JSON text.
 */
/**
 * Extracts a JSON substring from a larger raw text block.
 * @param {string} raw
 * @param {'array' | 'object' | 'auto'} [type]
 * @returns {string}
 */
export function extractJsonSubstring(raw: string, type: 'array' | 'object' | 'auto' = 'auto'): string {
  // Logic: Find brackets and extract inner content taking string escaping into account
  let cleaned = raw.trim()

  // 1. Extract content inside markdown code block if present
  const firstFence = cleaned.indexOf('```')
  if (firstFence !== -1) {
    const endFence = cleaned.lastIndexOf('```')
    if (endFence > firstFence) {
      let content = cleaned.slice(firstFence + 3, endFence).trim()
      if (content.toLowerCase().startsWith('json')) {
        content = content.slice(4).trim()
      }
      cleaned = content
    }
  }

  // 2. Determine target bracket type
  let openChar = ''
  let closeChar = ''

  if (type === 'array') {
    openChar = '['
    closeChar = ']'
  } else if (type === 'object') {
    openChar = '{'
    closeChar = '}'
  } else {
    const arrIdx = cleaned.indexOf('[')
    const objIdx = cleaned.indexOf('{')
    if (arrIdx !== -1 && (objIdx === -1 || arrIdx < objIdx)) {
      openChar = '['
      closeChar = ']'
    } else if (objIdx !== -1) {
      openChar = '{'
      closeChar = '}'
    } else {
      return cleaned
    }
  }

  const startIdx = cleaned.indexOf(openChar)
  if (startIdx === -1) return cleaned

  // 3. Balance bracket depth while accounting for string escaping
  let depth = 0
  let endIdx = -1
  let inString = false
  let escaped = false

  for (let i = startIdx; i < cleaned.length; i++) {
    const char = cleaned[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (!inString) {
      if (char === openChar) {
        depth++
      } else if (char === closeChar) {
        depth--
        if (depth === 0) {
          endIdx = i
          break
        }
      }
    }
  }

  if (endIdx !== -1) {
    return cleaned.slice(startIdx, endIdx + 1)
  }

  // Fallback if brackets are unclosed: slice to last occurrence of closeChar
  const lastClose = cleaned.lastIndexOf(closeChar)
  if (lastClose > startIdx) {
    return cleaned.slice(startIdx, lastClose + 1)
  }

  return cleaned.slice(startIdx)
}


