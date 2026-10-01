'use strict';

import type { ClosedTabEntry } from './types'
import { STORAGE_KEYS } from './constants'
import { normalizeUrl } from './utils'

export const MAX_CLOSED_TABS = 200

const IGNORED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'moz-extension://',
  'about:',
  'edge://',
  'devtools://',
]

/**
 * Validates whether a URL is restorable and not an internal browser page.
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isRestorableUrl(url?: string): boolean {
  if (!url || typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed || trimmed === 'about:blank') return false
  for (const prefix of IGNORED_URL_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false
  }
  return true
}

/**
 * Generates a unique ID for a closed tab entry.
 * @returns {string}
 */
function generateClosedTabId(): string {
  return `ct_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

/**
 * Retrieves all closed tab entries from chrome.storage.local without duplicate URLs.
 * @returns {Promise<ClosedTabEntry[]>}
 */
export async function getClosedTabs(): Promise<ClosedTabEntry[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  const data = await chrome.storage.local.get(STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION)
  const rawList = (data[STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION] ?? []) as ClosedTabEntry[]

  // Logic: Ensure returned list never contains duplicate URLs
  // Programming logic: Filter list using Set of normalized URLs
  const seenUrls = new Set<string>()
  const uniqueList: ClosedTabEntry[] = []
  for (const entry of rawList) {
    const key = normalizeUrl(entry.url) || entry.url
    if (!seenUrls.has(key)) {
      seenUrls.add(key)
      uniqueList.push(entry)
    }
  }
  return uniqueList
}

/**
 * Saves closed tab entries to chrome.storage.local, enforcing the maximum entry limit.
 * @param {ClosedTabEntry[]} entries
 * @returns {Promise<void>}
 */
async function saveClosedTabs(entries: ClosedTabEntry[]): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  const capped = entries.slice(0, MAX_CLOSED_TABS)
  await chrome.storage.local.set({ [STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION]: capped })
}

/**
 * Records an array of tabs closed by the extension into persistent storage.
 * @param {Array<{ url?: string; title?: string; favIconUrl?: string; groupTitle?: string; windowId?: number; batchId?: string }>} tabs
 * @param {string} source
 * @returns {Promise<void>}
 */
export async function recordClosedTabs(
  tabs: Array<{ url?: string; title?: string; favIconUrl?: string; groupTitle?: string; windowId?: number; batchId?: string }>,
  source: string
): Promise<void> {
  // Logic: Filter out invalid, internal, or empty URLs
  // Programming logic: Filter tabs by isRestorableUrl helper
  const validTabs = tabs.filter((t) => isRestorableUrl(t.url))
  if (validTabs.length === 0) return

  const now = Date.now()
  const newEntries: ClosedTabEntry[] = []
  const seenUrls = new Set<string>()

  // Logic: Deduplicate within the incoming batch so duplicate tabs appear at most once
  for (const t of validTabs) {
    const key = normalizeUrl(t.url!) || t.url!
    if (!seenUrls.has(key)) {
      seenUrls.add(key)
      newEntries.push({
        id: generateClosedTabId(),
        url: t.url!,
        title: t.title || t.url!,
        favIconUrl: t.favIconUrl,
        closedAt: now,
        source,
        groupTitle: t.groupTitle,
        windowId: t.windowId,
        batchId: t.batchId,
      })
    }
  }

  const existing = await getClosedTabs()
  // Logic: Exclude existing entries that share a URL with new entries
  const existingFiltered = existing.filter((e) => {
    const key = normalizeUrl(e.url) || e.url
    return !seenUrls.has(key)
  })

  const combined = [...newEntries, ...existingFiltered]
  await saveClosedTabs(combined)
}

/**
 * Fetches tab details from browser by tab IDs and records them before closure.
 * @param {number[]} tabIds
 * @param {string} source
 * @returns {Promise<void>}
 */
export async function recordTabIdsBeforeClose(tabIds: number[], source: string): Promise<void> {
  if (!tabIds || tabIds.length === 0 || typeof chrome === 'undefined' || !chrome.tabs) return
  const tabsToRecord: Array<{ url?: string; title?: string; favIconUrl?: string; windowId?: number }> = []

  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id)
      if (tab && isRestorableUrl(tab.url)) {
        tabsToRecord.push({
          url: tab.url,
          title: tab.title || tab.url,
          favIconUrl: tab.favIconUrl,
          windowId: tab.windowId,
        })
      }
    } catch {
      // Logic: Tab may already be closed or invalid, silently skip
    }
  }

  if (tabsToRecord.length > 0) {
    await recordClosedTabs(tabsToRecord, source)
  }
}

/**
 * Restores a closed tab by reopening it in the browser and removing it from history.
 * @param {string} id
 * @param {number} [targetWindowId]
 * @returns {Promise<chrome.tabs.Tab | null>}
 */
export async function restoreClosedTab(id: string, targetWindowId?: number): Promise<chrome.tabs.Tab | null> {
  const existing = await getClosedTabs()
  const index = existing.findIndex((e) => e.id === id)
  if (index === -1) return null

  const entry = existing[index]
  let createdTab: chrome.tabs.Tab | null = null

  if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
    const createProps: chrome.tabs.CreateProperties = { url: entry.url }
    if (targetWindowId !== undefined) {
      createProps.windowId = targetWindowId
    }
    createdTab = await chrome.tabs.create(createProps)
  }

  // Logic: Remove entry from storage after successful creation
  existing.splice(index, 1)
  await saveClosedTabs(existing)
  return createdTab
}

/**
 * Restores all closed tabs and clears the closed tabs history.
 * @param {number} [targetWindowId]
 * @returns {Promise<number>} Count of tabs restored
 */
export async function restoreAllClosedTabs(targetWindowId?: number): Promise<number> {
  const existing = await getClosedTabs()
  if (existing.length === 0) return 0

  let restoredCount = 0
  for (const entry of existing) {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      try {
        const createProps: chrome.tabs.CreateProperties = { url: entry.url }
        if (targetWindowId !== undefined) {
          createProps.windowId = targetWindowId
        }
        await chrome.tabs.create(createProps)
        restoredCount++
      } catch (err) {
        console.error('[timTabTool] Failed to reopen tab:', entry.url, err)
      }
    }
  }

  await clearClosedTabs()
  return restoredCount
}

/**
 * Deletes a specific closed tab entry from storage without reopening it.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function removeClosedTab(id: string): Promise<void> {
  const existing = await getClosedTabs()
  const filtered = existing.filter((e) => e.id !== id)
  await saveClosedTabs(filtered)
}

/**
 * Restores all tabs belonging to a specific batch and removes them from storage.
 * @param {string} batchId
 * @param {number} [targetWindowId]
 * @returns {Promise<number>} Count of tabs restored
 */
export async function restoreClosedBatch(batchId: string, targetWindowId?: number): Promise<number> {
  if (!batchId) return 0
  const existing = await getClosedTabs()
  const batchEntries = existing.filter((e) => e.batchId === batchId)
  if (batchEntries.length === 0) return 0

  let restoredCount = 0
  // Logic: Reopen in chronological order
  const chronological = [...batchEntries].reverse()
  for (const entry of chronological) {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      try {
        const createProps: chrome.tabs.CreateProperties = { url: entry.url }
        if (targetWindowId !== undefined) {
          createProps.windowId = targetWindowId
        }
        await chrome.tabs.create(createProps)
        restoredCount++
      } catch (err) {
        console.error('[timTabTool] Failed to restore batch tab:', entry.url, err)
      }
    }
  }

  const remaining = existing.filter((e) => e.batchId !== batchId)
  await saveClosedTabs(remaining)
  return restoredCount
}

/**
 * Removes all closed tabs belonging to a specific batch.
 * @param {string} batchId
 * @returns {Promise<void>}
 */
export async function removeClosedBatch(batchId: string): Promise<void> {
  if (!batchId) return
  const existing = await getClosedTabs()
  const remaining = existing.filter((e) => e.batchId !== batchId)
  await saveClosedTabs(remaining)
}

/**
 * Clears all closed tab entries from storage.
 * @returns {Promise<void>}
 */
export async function clearClosedTabs(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.remove(STORAGE_KEYS.CLOSED_TABS_BY_EXTENSION)
}
