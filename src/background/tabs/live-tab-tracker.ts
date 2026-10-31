'use strict';

import { recordClosedTabs, isRestorableUrl } from '../../shared/closed-tabs-manager'
import { markTabClosedInHistory, recordTabVisit } from '../storage'

export interface CachedLiveTab {
  id: number
  url?: string
  title?: string
  favIconUrl?: string
  windowId?: number
  groupId?: number
  index?: number
}

export interface TabRemoveInfo {
  windowId?: number
  isWindowClosing?: boolean
}

interface PendingMassCloseItem {
  tab: CachedLiveTab
  removeInfo: TabRemoveInfo
}

const liveTabMap = new Map<number, CachedLiveTab>()
const extensionClosingTabIds = new Set<number>()
let extensionClosingCleanupTimer: ReturnType<typeof setTimeout> | null = null

const pendingMassCloseItems: PendingMassCloseItem[] = []
let massCloseDebounceTimer: ReturnType<typeof setTimeout> | null = null
const MASS_CLOSE_DEBOUNCE_MS = 400

/**
 * Mark tab IDs as explicitly closed by timTabTool extension actions to avoid duplicate recording.
 */
export function markTabIdsClosedByExtension(tabIds: number[]): void {
  for (const id of tabIds) {
    if (id !== undefined && id > 0) {
      extensionClosingTabIds.add(id)
    }
  }
  if (extensionClosingCleanupTimer) {
    clearTimeout(extensionClosingCleanupTimer)
  }
  extensionClosingCleanupTimer = setTimeout(() => {
    extensionClosingTabIds.clear()
    extensionClosingCleanupTimer = null
  }, 10_000)
}

/**
 * Checks if a tab was marked as closed by the extension and consumes the mark.
 */
export function isTabClosedByExtension(tabId: number): boolean {
  if (extensionClosingTabIds.has(tabId)) {
    extensionClosingTabIds.delete(tabId)
    return true
  }
  return false
}

/**
 * Initialize live tab cache by querying all open tabs.
 */
export async function initLiveTabTracker(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query) return
  try {
    const tabs = await chrome.tabs.query({})
    if (!Array.isArray(tabs)) return
    liveTabMap.clear()
    for (const tab of tabs) {
      trackLiveTab(tab)
      if (tab.url && isRestorableUrl(tab.url)) {
        await recordTabVisit(tab.url, tab.title || tab.url, tab.favIconUrl)
      }
    }
  } catch (err) {
    console.error('[timTabTool] Failed to initialize live tab tracker:', err)
  }
}

/**
 * Update the in-memory cache for a single tab.
 */
export function trackLiveTab(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined || tab.id <= 0) return
  liveTabMap.set(tab.id, {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    windowId: tab.windowId,
    groupId: tab.groupId,
    index: tab.index,
  })
}

/**
 * Remove a tab from in-memory live tracking and return its cached metadata.
 */
export function untrackLiveTab(tabId: number): CachedLiveTab | undefined {
  const cached = liveTabMap.get(tabId)
  liveTabMap.delete(tabId)
  return cached
}

/**
 * Handle tab removal event to detect accidental mass tab or window closures.
 */
export function handleTabRemovalForMassClose(tabId: number, removeInfo: TabRemoveInfo): void {
  if (isTabClosedByExtension(tabId)) {
    const extCached = untrackLiveTab(tabId)
    if (extCached?.url) {
      markTabClosedInHistory([extCached.url]).catch(() => {})
    }
    return
  }

  const cached = untrackLiveTab(tabId)
  if (!cached || !cached.url) return

  if (!removeInfo.isWindowClosing) {
    markTabClosedInHistory([cached.url]).catch(() => {})
  }

  pendingMassCloseItems.push({ tab: cached, removeInfo })

  if (massCloseDebounceTimer) {
    clearTimeout(massCloseDebounceTimer)
  }

  massCloseDebounceTimer = setTimeout(() => {
    massCloseDebounceTimer = null
    flushPendingClosedTabs().catch((err) => {
      console.error('[timTabTool] Failed to flush pending mass close tabs:', err)
    })
  }, MASS_CLOSE_DEBOUNCE_MS)
}

/**
 * Flush pending closed tabs and record batches if 2+ tabs closed together or window closed.
 */
export async function flushPendingClosedTabs(): Promise<void> {
  if (pendingMassCloseItems.length === 0) return

  const items = pendingMassCloseItems.splice(0, pendingMassCloseItems.length)
  const byWindow = new Map<number, PendingMassCloseItem[]>()

  for (const item of items) {
    const wid = item.tab.windowId ?? item.removeInfo.windowId ?? 0
    const list = byWindow.get(wid) ?? []
    list.push(item)
    byWindow.set(wid, list)
  }

  for (const [windowId, winItems] of byWindow.entries()) {
    const isWindowClosing = winItems.some((i) => i.removeInfo.isWindowClosing)
    if (winItems.length >= 2 || isWindowClosing) {
      const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
      const source = isWindowClosing
        ? `Closed Window (${winItems.length} tabs)`
        : `Mass Close (${winItems.length} tabs)`

      const tabsToRecord = winItems.map((i) => ({
        url: i.tab.url,
        title: i.tab.title || i.tab.url,
        favIconUrl: i.tab.favIconUrl,
        windowId,
        batchId,
      }))

      await recordClosedTabs(tabsToRecord, source)
    }
  }
}

export function getLiveTabCount(): number {
  return liveTabMap.size
}

export function clearLiveTabs(): void {
  liveTabMap.clear()
  extensionClosingTabIds.clear()
  pendingMassCloseItems.length = 0
  if (massCloseDebounceTimer) {
    clearTimeout(massCloseDebounceTimer)
    massCloseDebounceTimer = null
  }
  if (extensionClosingCleanupTimer) {
    clearTimeout(extensionClosingCleanupTimer)
    extensionClosingCleanupTimer = null
  }
}
