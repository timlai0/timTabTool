'use strict';

import type { TabHistoryEntry } from '../shared/types'
import { STORAGE_KEYS } from '../shared/constants'

const MAX_HISTORY_ENTRIES = 500
const FLUSH_DELAY_MS = 5000

let inMemoryHistoryMap: Map<string, TabHistoryEntry> | null = null
let isHistoryDirty = false
let historyFlushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Load tab history from storage into memory cache if not already loaded.
 * @returns {Promise<Map<string, TabHistoryEntry>>} In-memory history map.
 */
async function getOrLoadHistory(): Promise<Map<string, TabHistoryEntry>> {
  if (inMemoryHistoryMap !== null) {
    return inMemoryHistoryMap
  }

  const data = await chrome.storage.local.get(STORAGE_KEYS.TAB_HISTORY)
  const entries = (data[STORAGE_KEYS.TAB_HISTORY] ?? []) as TabHistoryEntry[]
  inMemoryHistoryMap = new Map<string, TabHistoryEntry>()
  for (const entry of entries) {
    inMemoryHistoryMap.set(entry.url, entry)
  }
  return inMemoryHistoryMap
}

/**
 * Flush dirty in-memory history cache to chrome.storage.local.
 * @returns {Promise<void>}
 */
export async function flushTabHistory(): Promise<void> {
  if (historyFlushTimer) {
    clearTimeout(historyFlushTimer)
    historyFlushTimer = null
  }

  if (!isHistoryDirty || !inMemoryHistoryMap) {
    return
  }

  isHistoryDirty = false
  let entries = Array.from(inMemoryHistoryMap.values())
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries.sort((a, b) => b.lastAccessed - a.lastAccessed)
    entries = entries.slice(0, MAX_HISTORY_ENTRIES)
    inMemoryHistoryMap = new Map(entries.map((e) => [e.url, e]))
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.TAB_HISTORY]: entries })
}

/**
 * Schedule a debounced flush of tab history to persistent storage.
 */
function scheduleHistoryFlush(): void {
  if (historyFlushTimer) return
  historyFlushTimer = setTimeout(() => {
    historyFlushTimer = null
    flushTabHistory().catch((err) => {
      console.error('[timTabTool] Failed to flush tab history:', err)
    })
  }, FLUSH_DELAY_MS)
}

/**
 * Record a tab visit in history with in-memory caching and debounced write flushes.
 * @param {string} url - The URL of the visited tab.
 * @param {string} title - The title of the visited tab.
 * @param {string} [favIconUrl] - Optional URL of the tab's favicon.
 * @param {boolean} [immediate=false] - If true, flushes directly to persistent storage.
 * @returns {Promise<void>}
 */
export async function recordTabVisit(
  url: string,
  title: string,
  favIconUrl?: string,
  immediate: boolean = false
): Promise<void> {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) {
    return
  }

  const history = await getOrLoadHistory()
  const existing = history.get(url)

  history.set(url, {
    url,
    title,
    favIconUrl,
    lastAccessed: Date.now(),
    visitCount: (existing?.visitCount || 0) + 1,
    closed: false,
  })

  isHistoryDirty = true

  if (immediate) {
    await flushTabHistory()
  } else {
    scheduleHistoryFlush()
  }
}

/**
 * Get all history entries sorted by recency.
 * @returns {Promise<TabHistoryEntry[]>} Array of all history entries.
 */
export async function getHistoryEntries(): Promise<TabHistoryEntry[]> {
  const history = await getOrLoadHistory()
  return Array.from(history.values()).sort((a, b) => b.lastAccessed - a.lastAccessed)
}

