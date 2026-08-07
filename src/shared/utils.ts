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
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'fbclid', 'gclid', 'gbraid', 'wbraid', '_gl', 'msclkid', 'mc_cid', 'mc_eid',
  'ref', 'referrer', 'source', 'feature', 'si', 'igshid', 'fb_action_ids',
  'twclid', 'ttclid', 'yclid', 'mkt_tok', '_hsenc', '_openstat', 'gad_source',
  'spm', 'spm_id_from', 'scm', 'pvid', 'algo_pvid', 'algo_exp_id', 'btsid', 'ws_ab_test',
  'origin', 'vd_source', 'callback', '_t', 'from_source', 'from', 'is_from_webapp',
  'sender_device', 'refer', 'bd_vid', 'kwd', 'search_id', 'cmpid', 'via', 's_kwcid', 'dclid', 'zanpid'
])

export interface NormalizeUrlOptions {
  removeHash?: boolean
}

/**
 * Normalizes a URL by stripping tracking parameters.
 * @param {string} urlString
 * @param {NormalizeUrlOptions} [options]
 * @returns {string}
 */
export function normalizeUrl(urlString: string, options: NormalizeUrlOptions = {}): string {
  // Logic: Remove utm_ and other tracking params, sort search params for deduplication
  if (!urlString) return ''
  try {
    const url = new URL(urlString)
    
    // Clean tracking query params
    const keysToDelete: string[] = []
    url.searchParams.forEach((_, key) => {
      const lowerKey = key.toLowerCase()
      if (TRACKING_PARAMS.has(lowerKey) || lowerKey.startsWith('utm_') || lowerKey.startsWith('hsa_')) {
        keysToDelete.push(key)
      }
    })
    for (const key of keysToDelete) {
      url.searchParams.delete(key)
    }

    // Sort search parameters for deterministic URL matching
    url.searchParams.sort()

    // Remove hash fragment if specified (default: true)
    if (options.removeHash !== false) {
      url.hash = ''
    }

    // Normalize trailing slash for path (except root)
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }

    // Convert host to lowercase
    url.hostname = url.hostname.toLowerCase()

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
}

interface PossibleDuplicateCluster {
  cleanUrl: string
  domain: string
  tabs: MinimalTab[]
}

export interface DuplicateDetectionResult {
  exactDuplicateCount: number
  possibleDuplicateCount: number
  exactDuplicates: MinimalTab[]
  possibleDuplicates: PossibleDuplicateCluster[]
}

/**
 * Detects exact and possible duplicate tabs.
 * @param {MinimalTab[]} tabs
 * @returns {DuplicateDetectionResult}
 */
export function detectDuplicateTabs(tabs: MinimalTab[]): DuplicateDetectionResult {
  // Logic: Find exact matches by url, and possible matches by normalized url
  const urlSeen = new Map<string, MinimalTab[]>()
  const cleanUrlMap = new Map<string, MinimalTab[]>()

  for (const tab of tabs) {
    if (!tab.url) continue

    // Group exact URLs
    const exactList = urlSeen.get(tab.url) || []
    exactList.push(tab)
    urlSeen.set(tab.url, exactList)

    // Group clean URLs
    const cleanUrl = normalizeUrl(tab.url)
    const cleanList = cleanUrlMap.get(cleanUrl) || []
    cleanList.push(tab)
    cleanUrlMap.set(cleanUrl, cleanList)
  }

  // Exact duplicate tabs
  const exactDuplicates: MinimalTab[] = []
  let exactDuplicateCount = 0
  for (const group of urlSeen.values()) {
    if (group.length > 1) {
      exactDuplicateCount += group.length - 1
      exactDuplicates.push(...group.slice(1))
    }
  }

  // Possible duplicates
  const possibleDuplicates: PossibleDuplicateCluster[] = []
  let possibleDuplicateCount = 0

  for (const [cleanUrl, group] of cleanUrlMap.entries()) {
    if (group.length > 1) {
      const uniqueExactUrls = new Set(group.map(t => t.url))
      if (uniqueExactUrls.size > 1) {
        possibleDuplicateCount += group.length - 1
        const domain = extractDomain(cleanUrl) || (group[0].url ? extractDomain(group[0].url) : 'unknown')
        possibleDuplicates.push({
          cleanUrl,
          domain,
          tabs: group
        })
      }
    }
  }


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


