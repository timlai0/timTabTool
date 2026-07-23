export function extractDomain(url: string | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function getAutoBatchSize(maxTokens: number | undefined): number {
  const tokens = maxTokens || 16384
  return Math.min(100, Math.max(10, Math.floor(tokens / 500)))
}

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

export function getOptimalFaviconUrl(urlStr: string, fallbackFavIconUrl?: string): string {
  if (!urlStr) return ''
  try {
    const urlObj = new URL(urlStr)
    const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
    
    if (!isFirefox) {
      return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(urlObj.href)}&size=16`
    }
    
    // Firefox specific logic
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
    
    return `https://www.google.com/s2/favicons?sz=16&domain=${urlObj.hostname}`
  } catch {
    return ''
  }
}

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

