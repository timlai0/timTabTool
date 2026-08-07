import type { TabHistoryEntry } from '../shared/types'
import { STORAGE_KEYS } from '../shared/constants'

const MAX_HISTORY_ENTRIES = 500

/**
 * Load tab history from storage.
 * @returns {Promise<Map<string, TabHistoryEntry>>} A promise resolving to a map of URLs to tab history entries.
 */
async function loadHistory(): Promise<Map<string, TabHistoryEntry>> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TAB_HISTORY)
  const entries = (data[STORAGE_KEYS.TAB_HISTORY] ?? []) as TabHistoryEntry[]
  const map = new Map<string, TabHistoryEntry>()
  for (const entry of entries) {
    map.set(entry.url, entry)
  }
  return map
}

/**
 * Save tab history to storage.
 * @param {Map<string, TabHistoryEntry>} history - The history map to save.
 * @returns {Promise<void>}
 */
async function saveHistory(history: Map<string, TabHistoryEntry>): Promise<void> {
  // Keep only the most recent entries
  let entries = Array.from(history.values())
  // Logic: enforce maximum history entries by truncating the oldest ones
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries.sort((a, b) => b.lastAccessed - a.lastAccessed)
    entries = entries.slice(0, MAX_HISTORY_ENTRIES)
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.TAB_HISTORY]: entries })
}

/**
 * Record a tab visit in history.
 * @param {string} url - The URL of the visited tab.
 * @param {string} title - The title of the visited tab.
 * @param {string} [favIconUrl] - Optional URL of the tab's favicon.
 * @returns {Promise<void>}
 */
export async function recordTabVisit(url: string, title: string, favIconUrl?: string): Promise<void> {
  // Logic: skip tracking of restricted chrome/extension URLs
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return

  const history = await loadHistory()
  const existing = history.get(url)

  history.set(url, {
    url,
    title,
    favIconUrl,
    lastAccessed: Date.now(),
    visitCount: (existing?.visitCount || 0) + 1,
    closed: false,
  })

  await saveHistory(history)
}


/**
 * Get all history entries.
 * @returns {Promise<TabHistoryEntry[]>} A promise resolving to an array of all history entries, sorted by recency.
 */
export async function getHistoryEntries(): Promise<TabHistoryEntry[]> {
  const history = await loadHistory()
  return Array.from(history.values()).sort((a, b) => b.lastAccessed - a.lastAccessed)
}
