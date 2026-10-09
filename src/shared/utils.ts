'use strict';

export {
  extractDomain,
  TRACKING_PARAMS,
  DEFAULT_DOC_REGEX,
  isTrackingParam,
  isIgnoredSearchParam,
  isSpaHashRoute,
  stripDefaultDocumentFromPath,
  cleanUrlSearchParams,
  normalizeUrl,
} from './url-utils'

export type { NormalizeUrlOptions } from './url-utils'

/**
 * Calculates automatic batch size based on max tokens.
 * @param {number | undefined} maxTokens
 * @returns {number}
 */
export function getAutoBatchSize(maxTokens: number | undefined): number {
  const tokens = maxTokens || 16384
  return Math.min(100, Math.max(10, Math.floor(tokens / 500)))
}

/**
 * Parses max token string (like 16K) to a number.
 * @param {string | number | undefined} maxTokensStr
 * @returns {number}
 */
export function parseMaxTokensToNumber(maxTokensStr: string | number | undefined): number {
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
  if (!urlStr) return fallbackFavIconUrl || ''
  try {
    const urlObj = new URL(urlStr)
    const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
    
    if (!isFirefox && typeof chrome !== 'undefined' && chrome.runtime?.id) {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(urlObj.href)}&size=16`
    }
    
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

export type {
  MinimalTab,
  UrlVariantDiff,
  PossibleDuplicateCluster,
  DuplicateDetectionResult,
  DetectDuplicateOptions,
  ParsedUrlSegments,
} from './duplicate-detector'

export {
  DEFAULT_DETECT_OPTIONS,
  parseUrlSegments,
  getUrlVariantDifferences,
  calculateKeeperTabScore,
  groupTabsByUrl,
  extractExactDuplicates,
  buildClusterMatchReasons,
  buildPossibleDuplicateClusters,
  detectDuplicateTabs,
} from './duplicate-detector'

/**
 * Extracts clean JSON substring (array or object) from raw text, handling markdown code fences.
 * @param {string} raw
 * @param {'array' | 'object' | 'auto'} [type]
 * @returns {string}
 */
export function extractJsonSubstring(raw: string, type: 'array' | 'object' | 'auto' = 'auto'): string {
  let cleaned = raw.trim()

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

  const lastClose = cleaned.lastIndexOf(closeChar)
  if (lastClose > startIdx) {
    return cleaned.slice(startIdx, lastClose + 1)
  }

  return cleaned.slice(startIdx)
}

/**
 * Converts markdown text to sanitized HTML with code blocks, headings, lists, bold/italic, and inline code.
 * @param {string} text - Raw markdown text.
 * @returns {string} Sanitized HTML string.
 */
export function formatMarkdown(text: string): string {
  if (!text) return ''

  // Logic: Extract code blocks before HTML escaping to prevent internal markup mangling
  const codeBlocks: string[] = []
  let processed = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`
    const escapedCode = String(code)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    codeBlocks.push(
      `<pre class="my-1.5 p-2 rounded-xs font-mono text-[9px] bg-black/10 dark:bg-black/40 overflow-x-auto whitespace-pre leading-relaxed border border-black/5 dark:border-white/5 select-text"><code>${escapedCode}</code></pre>`
    )
    return placeholder
  })

  // Sanitize raw text to prevent XSS
  processed = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Headings
  processed = processed
    .replace(/^### (.*$)/gim, '<div class="font-bold text-[11px] mt-1.5 mb-0.5" style="color: var(--text-primary);">$1</div>')
    .replace(/^## (.*$)/gim, '<div class="font-bold text-[12px] mt-2 mb-1" style="color: var(--text-primary);">$1</div>')
    .replace(/^# (.*$)/gim, '<div class="font-bold text-[13px] mt-2.5 mb-1" style="color: var(--text-primary);">$1</div>')

  // Horizontal rules
  processed = processed.replace(/^---\s*$/gim, '<hr class="my-1.5 opacity-30" style="border-color: var(--border);" />')

  // Unordered list items (- or * or •)
  processed = processed.replace(/^\s*[-*•]\s+(.*$)/gim, '<div class="flex items-start gap-1.5 ml-1 my-0.5"><span class="opacity-50 select-none">•</span><span>$1</span></div>')

  // Ordered list items (1. 2. etc.)
  processed = processed.replace(/^\s*(\d+)\.\s+(.*$)/gim, '<div class="flex items-start gap-1.5 ml-1 my-0.5"><span class="opacity-60 select-none tabular-nums font-mono text-[8.5px]">$1.</span><span>$2</span></div>')

  // Inline styling: bold, italic, strikethrough, inline code
  processed = processed
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/~~(.*?)~~/g, '<del class="opacity-50">$1</del>')
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.2 rounded-xs text-[9px] font-mono bg-black/10 dark:bg-white/10 select-text">$1</code>')

  // Paragraphs & Linebreaks
  processed = processed
    .replace(/\n\n+/g, '<div class="h-1.5"></div>')
    .replace(/\n/g, '<br/>')

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`__CODE_BLOCK_${i}__`, codeBlocks[i])
  }

  return processed
}

