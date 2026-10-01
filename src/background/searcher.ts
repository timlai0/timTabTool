import type { SearchResult, TabInfo, TabHistoryEntry } from '../shared/types'

interface SearchTerm {
  term: string
  wordBoundaryRegex: RegExp
}

/**
 * Search open tabs and history by keyword matching on title and URL.
 * Uses a simple scoring system: title match scores higher than URL match,
 * exact match scores higher than partial.
 * @param {string} query - The search query.
 * @param {TabInfo[]} openTabs - The array of currently open tabs.
 * @param {TabHistoryEntry[]} historyEntries - The array of tab history entries.
 * @param {number} [currentWindowId] - Optional ID of the current window to boost scores for tabs in the same window.
 * @returns {SearchResult[]} An array of search results sorted by score and recency.
 */
export function searchTabs(
  query: string,
  openTabs: TabInfo[],
  historyEntries: TabHistoryEntry[],
  currentWindowId?: number,
  includeClosedWhenEmpty: boolean = false,
): SearchResult[] {
  // Logic: if query is empty, return open tabs (and closed tabs if requested) sorted by recency
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
    const openResults: SearchResult[] = sorted.map((t) => ({
      tab: t,
      score: 0,
      isOpen: true,
      scoreDetails: 'Recently used',
    }))

    if (!includeClosedWhenEmpty) {
      return openResults
    }

    const openUrls = new Set(openTabs.map((t) => t.url))
    const closedSorted = historyEntries
      .filter((e) => !openUrls.has(e.url))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))

    const closedResults: SearchResult[] = closedSorted.map((entry) => ({
      tab: entry,
      score: 0,
      isOpen: false,
      scoreDetails: 'Recently closed',
    }))

    return [...openResults, ...closedResults].slice(0, 50)
  }

  const terms: SearchTerm[] = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => ({
      term,
      wordBoundaryRegex: new RegExp(`\\b${escapeRegex(term)}\\b`, 'i'),
    }))

  const results: SearchResult[] = []

  // Score open tabs
  // Logic: iterate open tabs and compute relevance score
  for (const tab of openTabs) {
    const { score: matchScore, details: matchDetails } = computeScore(terms, tab.title, tab.url, tab.groupTitle)
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

  // Sort by score descending, then by lastAccessed descending
  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    const timeA = a.tab.lastAccessed || 0
    const timeB = b.tab.lastAccessed || 0
    return timeB - timeA
  })

  return results.slice(0, 50)
}

/**
 * Compute a relevance score for a tab against search terms.
 * @param {SearchTerm[]} terms - The parsed search terms to score against.
 * @param {string} title - The title of the tab.
 * @param {string} url - The URL of the tab.
 * @param {string} [groupTitle] - The optional group title of the tab.
 * @returns {{ score: number; details: string }} An object with the total score and score details string.
 */
function computeScore(terms: SearchTerm[], title: string, url: string, groupTitle?: string): { score: number; details: string } {
  const titleLower = (title || '').toLowerCase()
  const urlLower = (url || '').toLowerCase()
  const groupTitleLower = (groupTitle || '').toLowerCase()

  let totalScore = 0
  const detailsParts: string[] = []

  let domain = ''
  try {
    domain = new URL(url).hostname.toLowerCase()
  } catch {
    // ignore
  }

  for (const { term, wordBoundaryRegex } of terms) {
    let titleScore = 0
    let urlScore = 0
    let groupScore = 0

    // Title match
    if (titleLower.includes(term)) {
      titleScore += 3
      // Bonus for word boundary match
      if (wordBoundaryRegex.test(title || '')) {
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
      if (domain && domain.includes(term)) {
        urlScore += 1
      }
    }

    // Group Title match
    if (groupTitleLower.includes(term)) {
      groupScore += 2
      if (wordBoundaryRegex.test(groupTitle || '')) {
        groupScore += 1
      }
      if (groupTitleLower.startsWith(term)) {
        groupScore += 1
      }
    }

    if (titleScore === 0 && urlScore === 0 && groupScore === 0) {
      // If any term doesn't match, return 0 (AND logic)
      return { score: 0, details: '' }
    }
    
    if (titleScore > 0) detailsParts.push(`Title +${titleScore}`)
    if (urlScore > 0) detailsParts.push(`URL +${urlScore}`)
    if (groupScore > 0) detailsParts.push(`Group +${groupScore}`)
    
    totalScore += (titleScore + urlScore + groupScore)
  }

  return { score: totalScore, details: detailsParts.join(' | ') }
}

/**
 * Escapes special regex characters in a string.
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
