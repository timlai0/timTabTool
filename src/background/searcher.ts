import type { SearchResult, TabInfo, TabHistoryEntry } from '../shared/types'

/**
 * Search open tabs and history by keyword matching on title and URL.
 * Uses a simple scoring system: title match scores higher than URL match,
 * exact match scores higher than partial.
 */
export function searchTabs(
  query: string,
  openTabs: TabInfo[],
  historyEntries: TabHistoryEntry[],
  currentWindowId?: number,
): SearchResult[] {
  if (!query.trim()) {
    // Sort open tabs by lastAccessed descending
    const sorted = [...openTabs].sort((a, b) => {
      const timeA = a.lastAccessed || 0
      const timeB = b.lastAccessed || 0
      if (timeA !== timeB) {
        return timeB - timeA
      }
      return b.id - a.id
    })
    return sorted.map((t) => ({
      tab: t,
      score: 0,
      isOpen: true,
      scoreDetails: 'Recently used',
    }))
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const results: SearchResult[] = []

  // Score open tabs
  for (const tab of openTabs) {
    const { score: matchScore, details: matchDetails } = computeScore(terms, tab.title, tab.url)
    if (matchScore > 0) {
      const isSameWindow = currentWindowId !== undefined && tab.windowId === currentWindowId
      const windowBoost = isSameWindow ? 1 : 0.5
      const windowDetails = isSameWindow ? 'Same Window +1' : 'Diff Window +0.5'
      
      const finalScore = matchScore + windowBoost
      const finalDetails = matchDetails ? `${matchDetails} | ${windowDetails}` : windowDetails
      
      results.push({ tab, score: finalScore, isOpen: true, scoreDetails: finalDetails })
    }
  }

  // Score history entries (only closed ones, to avoid duplicates with open tabs)
  const openUrls = new Set(openTabs.map((t) => t.url))
  for (const entry of historyEntries) {
    if (openUrls.has(entry.url)) continue

    const { score, details } = computeScore(terms, entry.title, entry.url)
    if (score > 0) {
      // Boost by recency (decay over 7 days)
      const ageMs = Date.now() - entry.lastAccessed
      const ageDays = ageMs / (1000 * 60 * 60 * 24)
      const recencyBoost = Math.max(0, 1 - ageDays / 7) * 0.2
      const finalScore = score + recencyBoost
      const boostStr = recencyBoost > 0 ? ` | History +${recencyBoost.toFixed(2)}` : ''
      results.push({ tab: entry, score: finalScore, isOpen: false, scoreDetails: details + boostStr })
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  return results.slice(0, 50)
}

/**
 * Compute a relevance score for a tab against search terms.
 */
function computeScore(terms: string[], title: string, url: string): { score: number; details: string } {
  const titleLower = (title || '').toLowerCase()
  const urlLower = (url || '').toLowerCase()

  let totalScore = 0
  const detailsParts: string[] = []

  for (const term of terms) {
    let titleScore = 0
    let urlScore = 0

    // Title match
    if (titleLower.includes(term)) {
      titleScore += 3
      // Bonus for word boundary match
      const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'i')
      if (regex.test(title || '')) {
        titleScore += 1
      }
      // Bonus for match at start
      if (titleLower.startsWith(term)) {
        titleScore += 1
      }
    }

    // URL match (lower weight)
    if (urlLower.includes(term)) {
      urlScore += 1
      // Domain match bonus
      try {
        const domain = new URL(url).hostname.toLowerCase()
        if (domain.includes(term)) {
          urlScore += 1
        }
      } catch {
        // ignore
      }
    }

    if (titleScore === 0 && urlScore === 0) {
      // If any term doesn't match, return 0 (AND logic)
      return { score: 0, details: '' }
    }
    
    if (titleScore > 0) detailsParts.push(`Title +${titleScore}`)
    if (urlScore > 0) detailsParts.push(`URL +${urlScore}`)
    
    totalScore += (titleScore + urlScore)
  }

  return { score: totalScore, details: detailsParts.join(' | ') }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
