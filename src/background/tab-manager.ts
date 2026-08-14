import { classify, classifyTabs, groupTabsFreelyWithAI } from './classifier'
import type { FreeGroupResult } from './classifier'
import { GROUP_DEFINITIONS, STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants'
import { extractDomain, normalizeUrl, detectDuplicateTabs } from '../shared/utils'
import { getMessage } from '../shared/i18n'
import { AIClient, SYSTEM_PROMPT } from '../shared/ai-client'
import { AILogger, setActivityCallback } from '../shared/ai-logger'
import type { GroupCategory, GroupedTabs, TabInfo, ExtensionSettings, ChromeTabGroupColor, LastAIResult } from '../shared/types'

function isTabGroupsSupported(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.tabGroups !== 'undefined'
}

const TAB_GROUP_ID_NONE = isTabGroupsSupported() ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1

const CACHE_DEBOUNCE_MS = 300
const TAB_RETRY_ATTEMPTS = 3
const TAB_RETRY_DELAY_MS = 200
/** Per-window preview cache. Key: windowId */
const previewCacheMap = new Map<number, GroupedTabs[]>()
/** Which windows have AI-generated groups (for cache restore behavior). */
const cacheIsAIGroupedMap = new Map<number, boolean>()

/** Tracks active AbortControllers for cancellation. Key: windowId */
const activeAbortControllers = new Map<number, AbortController>()
const activeTimeoutIds = new Map<number, ReturnType<typeof setTimeout>>()
const activeTimeoutLoggers = new Map<number, AILogger | undefined>()

const OPERATION_TIMEOUT_MS = 270_000 // 4.5 minutes

const timeoutEndTimestamps = new Map<number, number>()
const autoExtendCounts = new Map<number, number>()

/**
 * Set up a timeout for a background operation to prevent it from running indefinitely.
 * @param {number} windowId - The ID of the window where the operation is running.
 * @param {AbortController} controller - The abort controller for the operation.
 * @param {AILogger} [logger] - Optional AI logger instance.
 */
export function setupOperationTimeout(windowId: number, controller: AbortController, logger?: AILogger): void {
  clearOperationTimeout(windowId)
  if (logger) {
    activeTimeoutLoggers.set(windowId, logger)
  }

  const endTs = Date.now() + OPERATION_TIMEOUT_MS
  timeoutEndTimestamps.set(windowId, endTs)

  const timeoutId = setTimeout(() => {
    const activeLogger = activeTimeoutLoggers.get(windowId)
    if (activeLogger) {
      activeLogger.logStep('TIMEOUT_ABORT', 'Operation timed out after 4.5 minutes without user extension.')
    }
    controller.abort(new Error('Operation timed out (Chrome 5-minute limit approaching). Please process fewer tabs at once or click "Extend (+5m)".'))
  }, OPERATION_TIMEOUT_MS)

  activeTimeoutIds.set(windowId, timeoutId)
}

export function registerTimeoutLogger(windowId: number, logger?: AILogger): void {
  if (logger) {
    activeTimeoutLoggers.set(windowId, logger)
  }
}

export function clearOperationTimeout(windowId: number): void {
  const existing = activeTimeoutIds.get(windowId)
  if (existing) {
    clearTimeout(existing)
    activeTimeoutIds.delete(windowId)
  }
  activeTimeoutLoggers.delete(windowId)
  timeoutEndTimestamps.delete(windowId)
  autoExtendCounts.delete(windowId)
}

export function extendOperationTimeout(windowId: number): boolean {
  const controller = activeAbortControllers.get(windowId)
  if (!controller || controller.signal.aborted) return false

  const count = (autoExtendCounts.get(windowId) ?? 0) + 1
  autoExtendCounts.set(windowId, count)

  const logger = activeTimeoutLoggers.get(windowId)
  setupOperationTimeout(windowId, controller, logger)

  if (logger) {
    logger.logStep('EXTEND_TIMEOUT', 'User extended operation timeout by an additional 4.5 minutes.')
  }

  const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
  chrome.runtime.sendMessage({
    action: 'AI_OPERATION_EXTENDED',
    payload: {
      windowId,
      remainingSeconds: Math.round(OPERATION_TIMEOUT_MS / 1000),
      endTimestamp: endTs,
      autoExtendCount: count,
    }
  }).catch(() => {})

  if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
    chrome.runtime.getPlatformInfo().catch(() => {})
  }

  return true
}

const lastAutoExtendMap = new Map<number, number>()
let isAutoExtending = false

export function autoExtendOperationTimeout(windowId: number): boolean {
  if (isAutoExtending) return false

  const now = Date.now()
  const lastTime = lastAutoExtendMap.get(windowId) ?? 0
  // Throttle auto-extension to at most once every 30 seconds per window
  if (now - lastTime < 30_000) {
    return false
  }

  isAutoExtending = true
  try {
    const controller = activeAbortControllers.get(windowId)
    if (!controller || controller.signal.aborted) return false

    lastAutoExtendMap.set(windowId, now)
    const count = (autoExtendCounts.get(windowId) ?? 0) + 1
    autoExtendCounts.set(windowId, count)

    const logger = activeTimeoutLoggers.get(windowId)
    setupOperationTimeout(windowId, controller, logger)

    if (logger) {
      logger.logStepDirect('AUTO_EXTEND_TIMEOUT', `Auto-extended operation timeout by 4.5 minutes due to active AI progress (Extension #${count}).`)
    }

    const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
    chrome.runtime.sendMessage({
      action: 'AI_OPERATION_EXTENDED',
      payload: {
        windowId,
        remainingSeconds: Math.round(OPERATION_TIMEOUT_MS / 1000),
        endTimestamp: endTs,
        autoExtendCount: count,
      }
    }).catch(() => {})

    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo().catch(() => {})
    }

    return true
  } finally {
    isAutoExtending = false
  }
}

// Automatically reset operation timeout whenever AI progress activity occurs
setActivityCallback((windowId: number) => {
  autoExtendOperationTimeout(windowId)
})

export interface OperationStatus {
  type: 'group' | 'classify' | 'split' | 'merge' | null
  error: string | null
  batchCurrent?: number
  batchTotal?: number
  processedTabs?: number
  totalTabs?: number
  statusText?: string
  timeoutRemainingSec?: number
  timeoutEndTimestamp?: number
  lastAutoExtendTimestamp?: number
  autoExtendCount?: number
}

const activeOperationsMap = new Map<number, OperationStatus>()

/**
 * Update the progress of an active operation and broadcast to listeners.
 * @param {number} windowId - The window ID.
 * @param {object} details - Progress details including batch info and status.
 */
export function updateOperationProgress(
  windowId: number,
  details: {
    batchCurrent?: number
    batchTotal?: number
    processedTabs?: number
    totalTabs?: number
    statusText?: string
  }
): void {
  // Logic: apply details to existing operation status and broadcast update
  const current = activeOperationsMap.get(windowId)
  if (!current) return

  const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
  const remainingSec = Math.max(0, Math.round((endTs - Date.now()) / 1000))
  const extendCount = autoExtendCounts.get(windowId) ?? 0

  const updated: OperationStatus = {
    ...current,
    ...details,
    timeoutRemainingSec: remainingSec,
    timeoutEndTimestamp: endTs,
    autoExtendCount: extendCount,
  }

  activeOperationsMap.set(windowId, updated)

  chrome.runtime.sendMessage({
    action: 'AI_OPERATION_PROGRESS',
    payload: {
      windowId,
      status: updated,
    }
  }).catch(() => {})

  chrome.runtime.sendMessage({
    action: 'ACTIVE_OPERATIONS_UPDATED',
    payload: getActiveOperations()
  }).catch(() => {})
}

export function setActiveOperation(windowId: number, type: 'group' | 'classify' | 'split' | 'merge' | null, error: string | null = null): void {
  if (type === null && error === null) {
    activeOperationsMap.delete(windowId)
  } else {
    const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
    const remainingSec = Math.max(0, Math.round((endTs - Date.now()) / 1000))
    const existing = activeOperationsMap.get(windowId)
    activeOperationsMap.set(windowId, {
      ...existing,
      type,
      error,
      timeoutRemainingSec: remainingSec,
      timeoutEndTimestamp: endTs,
      autoExtendCount: autoExtendCounts.get(windowId) ?? 0,
    })
  }
  chrome.runtime.sendMessage({
    action: 'ACTIVE_OPERATIONS_UPDATED',
    payload: getActiveOperations()
  }).catch(() => {})
}

export function getActiveOperations(): Record<number, OperationStatus> {
  const result: Record<number, OperationStatus> = {}
  for (const [windowId, status] of activeOperationsMap.entries()) {
    result[windowId] = status
  }
  return result
}

export function clearOperationError(windowId: number): void {
  const status = activeOperationsMap.get(windowId)
  if (status) {
    status.error = null
    if (status.type === null) {
      activeOperationsMap.delete(windowId)
    }
  }
}

export function clearWindowCache(windowId: number): void {
  previewCacheMap.delete(windowId)
  cacheIsAIGroupedMap.delete(windowId)
  titlesHiddenMap.delete(windowId)
  activeOperationsMap.delete(windowId)
  const controller = activeAbortControllers.get(windowId)
  if (controller) {
    controller.abort()
    activeAbortControllers.delete(windowId)
  }
}

// --- Smart group title state ---
// Maps Chrome groupId → stored display title (used to enforce persistent titles)
const groupTitleMap = new Map<number, string>()
// Tracks groups currently being updated by us to prevent infinite loops
const updatingGroups = new Set<number>()
// Per-window: whether group titles are hidden in Chrome tab bar
const titlesHiddenMap = new Map<number, boolean>()

async function retryTabOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < TAB_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const errMsg = err?.message || String(err)
      const isMissingTab = errMsg.includes('No tab with id') || errMsg.includes('Invalid tab id') || errMsg.includes('No group with id') || errMsg.includes('Invalid group id')
      if (isMissingTab) {
        console.warn('[timTabTool] Tab or group no longer exists during operation (ignored):', errMsg)
        return undefined as unknown as T
      }
      const isRetryable =
        err instanceof Error && err.message.includes('Tabs cannot be edited right now')
      if (!isRetryable || attempt === TAB_RETRY_ATTEMPTS - 1) throw err
      await new Promise((r) => setTimeout(r, TAB_RETRY_DELAY_MS * (attempt + 1)))
    }
  }
  throw new Error('retryTabOperation: unreachable')
}

async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
  return { 
    ...DEFAULT_SETTINGS, 
    ...saved,
    ai: { ...DEFAULT_SETTINGS.ai, ...saved.ai },
  }
}

const tabCreatedTimesMap = new Map<number, number>()

export function recordTabCreatedTime(tabId: number, time = Date.now()): void {
  if (!tabCreatedTimesMap.has(tabId)) {
    tabCreatedTimesMap.set(tabId, time)
  }
}

export function removeTabCreatedTime(tabId: number): void {
  tabCreatedTimesMap.delete(tabId)
}

function tabsFromChrome(
  chromeTabs: chrome.tabs.Tab[],
  tabIds: number[],
  tabMap?: Map<number, chrome.tabs.Tab>,
): TabInfo[] {
  if (tabMap) {
    const result: TabInfo[] = []
    for (const id of tabIds) {
      const t = tabMap.get(id)
      if (t) {
        const info = chromeTabToTabInfo(t)
        if (info) result.push(info)
      }
    }
    return result
  }
  const tabIdSet = new Set(tabIds)
  return chromeTabs
    .filter((t) => t.id !== undefined && tabIdSet.has(t.id))
    .map((t) => chromeTabToTabInfo(t))
    .filter((t): t is TabInfo => t !== null)
}

function chromeTabToTabInfo(tab: chrome.tabs.Tab): TabInfo | null {
  if (tab.id === undefined) return null
  return {
    id: tab.id,
    url: tab.url || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    lastAccessed: tab.lastAccessed,
    createdAt: tabCreatedTimesMap.get(tab.id) ?? tab.lastAccessed,
  }
}

function sortGroups(groups: GroupedTabs[]): GroupedTabs[] {
  return groups.sort((a, b) => {
    if (a.isPinnedGroup || a.groupName === 'Pinned') return -1
    if (b.isPinnedGroup || b.groupName === 'Pinned') return 1
    const isOtherA = a.category === 'other' && !a.groupId && (a.groupName === '_ungrouped_' || !a.groupName)
    const isOtherB = b.category === 'other' && !b.groupId && (b.groupName === '_ungrouped_' || !b.groupName)
    if (isOtherA && !isOtherB) return 1
    if (isOtherB && !isOtherA) return -1
    if (a.groupId && b.groupId) return 0
    return b.tabs.length - a.tabs.length
  })
}

function freeGroupsToGroupedTabs(
  freeGroups: FreeGroupResult[],
  chromeTabs: chrome.tabs.Tab[],
): GroupedTabs[] {
  const tabMap = new Map<number, chrome.tabs.Tab>()
  for (const t of chromeTabs) {
    if (t.id !== undefined) tabMap.set(t.id, t)
  }

  const result: GroupedTabs[] = freeGroups
    .map((g) => ({
      category: 'other' as GroupCategory,
      tabs: tabsFromChrome(chromeTabs, g.tabIds, tabMap),
      groupName: g.name,
      groupColor: g.color,
    }))
    .filter((g) => g.tabs.length > 0)

  const pinnedTabs = chromeTabs.filter((t) => t.pinned)
  if (pinnedTabs.length > 0) {
    const pinnedInfos = pinnedTabs
      .map((t) => chromeTabToTabInfo(t))
      .filter((t): t is TabInfo => t !== null)
    if (pinnedInfos.length > 0) {
      result.unshift({
        category: 'other' as GroupCategory,
        groupName: 'Pinned',
        isPinnedGroup: true,
        tabs: pinnedInfos,
      })
    }
  }

  const groupedTabIds = new Set(freeGroups.flatMap((g) => g.tabIds))
  const unpinnedUngrouped = chromeTabs.filter(
    (t) => !t.pinned && (t.id !== undefined && !groupedTabIds.has(t.id)),
  )
  if (unpinnedUngrouped.length > 0) {
    const unpinnedInfos = unpinnedUngrouped
      .map((t) => chromeTabToTabInfo(t))
      .filter((t): t is TabInfo => t !== null)
    if (unpinnedInfos.length > 0) {
      result.push({
        category: 'other' as GroupCategory,
        groupName: '_ungrouped_',
        tabs: unpinnedInfos,
      })
    }
  }

  return result
}

function ruleGroupsToGroupedTabs(
  groups: Map<GroupCategory, number[]>,
  chromeTabs: chrome.tabs.Tab[],
): GroupedTabs[] {
  const result: GroupedTabs[] = []
  const tabMap = new Map<number, chrome.tabs.Tab>()
  for (const t of chromeTabs) {
    if (t.id !== undefined) tabMap.set(t.id, t)
  }

  const pinnedTabs = chromeTabs.filter((t) => t.pinned)
  if (pinnedTabs.length > 0) {
    const pinnedInfos = pinnedTabs
      .map((t) => chromeTabToTabInfo(t))
      .filter((t): t is TabInfo => t !== null)
    if (pinnedInfos.length > 0) {
      result.push({
        category: 'other' as GroupCategory,
        groupName: 'Pinned',
        isPinnedGroup: true,
        tabs: pinnedInfos,
      })
    }
  }

  for (const [category, tabIds] of groups) {
    const categoryTabs = tabsFromChrome(chromeTabs, tabIds, tabMap)
    if (categoryTabs.length > 0) {
      result.push({ category, tabs: categoryTabs })
    }
  }

  return result
}

// --- Cache management ---

export function invalidatePreviewCache(windowId?: number): void {
  if (windowId !== undefined) {
    previewCacheMap.delete(windowId)
    cacheIsAIGroupedMap.delete(windowId)
  } else {
    previewCacheMap.clear()
    cacheIsAIGroupedMap.clear()
  }
}

export function cacheAddTab(tab: chrome.tabs.Tab): void {
  const windowId = tab.windowId
  let previewCache = previewCacheMap.get(windowId)
  if (!previewCache) return

  const tabInfo = chromeTabToTabInfo(tab)
  if (!tabInfo) return

  if (tab.pinned) {
    let pinnedGroup = previewCache.find((g) => g.isPinnedGroup || g.groupName === 'Pinned')
    if (pinnedGroup) {
      pinnedGroup.tabs.push(tabInfo)
    } else {
      previewCache.unshift({
        category: 'other' as GroupCategory,
        groupName: 'Pinned',
        isPinnedGroup: true,
        tabs: [tabInfo],
      })
    }
    sortGroups(previewCache)
    return
  }

  const cacheIsAIGrouped = cacheIsAIGroupedMap.get(windowId) ?? false
  if (cacheIsAIGrouped) {
    const ungrouped = previewCache.find((g) => g.category === 'other' && (g.groupName === '_ungrouped_' || !g.groupName) && !g.isPinnedGroup)
    if (ungrouped) {
      ungrouped.tabs.push(tabInfo)
    } else {
      previewCache.push({
        category: 'other' as GroupCategory,
        groupName: '_ungrouped_',
        tabs: [tabInfo],
      })
    }
    sortGroups(previewCache)
    return
  }

  const result = classify(tab.url, tab.title)
  const category = result.category

  const group = previewCache.find((g) => g.category === category && !g.groupName && !g.isPinnedGroup)
  if (group) {
    group.tabs.push(tabInfo)
  } else {
    previewCache.push({ category, tabs: [tabInfo] })
  }
  sortGroups(previewCache)
}

export function cacheRemoveTab(tabId: number): void {
  for (const [windowId, previewCache] of previewCacheMap) {
    let found = false
    for (let i = previewCache.length - 1; i >= 0; i--) {
      const group = previewCache[i]
      const before = group.tabs.length
      group.tabs = group.tabs.filter((t) => t.id !== tabId)
      if (group.tabs.length !== before) found = true
      if (group.tabs.length === 0) {
        previewCache.splice(i, 1)
      }
    }
    if (previewCache.length === 0) {
      previewCacheMap.delete(windowId)
    }
    if (found) break
  }
}

export function cacheUpdateTab(tab: chrome.tabs.Tab): void {
  const windowId = tab.windowId
  const previewCache = previewCacheMap.get(windowId)
  if (!previewCache || tab.id === undefined) return

  const cacheIsAIGrouped = cacheIsAIGroupedMap.get(windowId) ?? false
  if (cacheIsAIGrouped) {
    // When AI-grouped, update tab metadata in-place without re-classifying.
    // This preserves the AI group assignment.
    const tabInfo = chromeTabToTabInfo(tab)
    if (!tabInfo) return

    for (const group of previewCache) {
      const idx = group.tabs.findIndex((t) => t.id === tab.id)
      if (idx !== -1) {
        group.tabs[idx] = tabInfo
        return
      }
    }
    // Tab not found in any group — treat as new tab
    cacheAddTab(tab)
    return
  }

  cacheRemoveTab(tab.id)

  const tabInfo = chromeTabToTabInfo(tab)
  if (!tabInfo) return

  const result = classify(tab.url, tab.title)
  const category = result.category

  const group = previewCache.find((g) => g.category === category && !g.groupName)
  if (group) {
    group.tabs.push(tabInfo)
  } else {
    previewCache.push({ category, tabs: [tabInfo] })
  }
  sortGroups(previewCache)
}

const RESTRICTED_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'moz-extension://', 'about:', 'edge://']

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true
  return RESTRICTED_URL_PREFIXES.some((p) => url.startsWith(p))
}

export async function autoGroupNewTab(tab: chrome.tabs.Tab): Promise<void> {
  // Logic: Abort if tab groups are not supported in the browser (e.g. Firefox)
  // Programming logic: Return early if tab groups are not supported in this browser (e.g. Firefox)
  if (!isTabGroupsSupported()) return
  if (!tab.id || tab.pinned || isRestrictedUrl(tab.url)) return
  const windowId = tab.windowId
  if (!(cacheIsAIGroupedMap.get(windowId) ?? false)) return
  if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE) return

  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const settings = (data[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS) as ExtensionSettings
  if (settings.sortNewTabs === false) {
    debouncedUpdateNewTabsBadge(windowId)
    return
  }

  const allTabs = await chrome.tabs.query({ windowId })
  const ungroupedTabs = allTabs.filter(
    (t) => !t.pinned && (t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE)
  )

  if (ungroupedTabs.length > 1) {
    const sorted = sortTabsByDomainAndTitleHelper(ungroupedTabs)
    const tabIds = sorted.map(t => t.id).filter((id): id is number => id !== undefined)
    
    await retryTabOperation(() => chrome.tabs.move(tabIds, { index: -1 }))
  }

  debouncedUpdateNewTabsBadge(windowId)
}

/**
 * Update the extension badge to show how many tabs are duplicates.
 */
async function updateNewTabsBadge(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })

  const urlCounts = new Map<string, number>()
  for (const t of tabs) {
    if (t.url) {
      urlCounts.set(t.url, (urlCounts.get(t.url) || 0) + 1)
    }
  }

  let duplicateCount = 0
  for (const count of urlCounts.values()) {
    if (count > 1) {
      duplicateCount += count - 1
    }
  }

  await chrome.action.setBadgeText({ text: duplicateCount > 0 ? String(duplicateCount) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: duplicateCount > 0 ? 'red' : '#6B7280' })
}

const badgeTimeoutsByWindow = new Map<number, ReturnType<typeof setTimeout>>()
function debouncedUpdateNewTabsBadge(windowId: number): void {
  const existing = badgeTimeoutsByWindow.get(windowId)
  if (existing) clearTimeout(existing)
  badgeTimeoutsByWindow.set(
    windowId,
    setTimeout(() => {
      badgeTimeoutsByWindow.delete(windowId)
      updateNewTabsBadge(windowId).catch(console.error)
    }, CACHE_DEBOUNCE_MS)
  )
}

async function setAIBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: 'AI' })
  await chrome.action.setBadgeBackgroundColor({ color: '#8B5CF6' })
}

/**
 * Rebuild the cache of grouped tabs for a given window.
 * @param {number} windowId - The window ID.
 */
async function rebuildCache(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })

  // Try to restore from Chrome tab groups (handles manual groupings and service worker restarts)
  // Logic: restore cache from chrome API if supported, otherwise fallback to settings/rules
  const fromChrome = await buildGroupsFromChrome(tabs)
  if (fromChrome) {
    previewCacheMap.set(windowId, sortGroups(fromChrome))
    cacheIsAIGroupedMap.set(windowId, fromChrome.some((g) => !!g.groupName))
  } else {
    const settings = await getSettings()
    if (settings.showRuleGroupsWhenUngrouped === false) {
      const tabInfos = tabs
        .map((t) => chromeTabToTabInfo(t))
        .filter((t): t is TabInfo => t !== null)
      previewCacheMap.set(windowId, [
        {
          category: 'other' as GroupCategory,
          tabs: tabInfos,
        }
      ])
    } else {
      previewCacheMap.set(windowId, sortGroups(ruleGroupsToGroupedTabs(classifyTabs(tabs), tabs)))
    }
    cacheIsAIGroupedMap.set(windowId, false)
  }
}

const rebuildTimeoutsByWindow = new Map<number, ReturnType<typeof setTimeout>>()
export function debouncedCacheRebuild(windowId: number): void {
  const op = activeOperationsMap.get(windowId)
  if (op && op.type) {
    // Skip redundant intermediate cache rebuilds while a batch operation (grouping/classifying) is active
    return
  }
  const existing = rebuildTimeoutsByWindow.get(windowId)
  if (existing) clearTimeout(existing)
  rebuildTimeoutsByWindow.set(
    windowId,
    setTimeout(() => {
      rebuildTimeoutsByWindow.delete(windowId)
      rebuildCache(windowId)
    }, CACHE_DEBOUNCE_MS),
  )
}

// --- Restore groups from Chrome tab groups ---

/**
 * Read the actual Chrome tab group state and build GroupedTabs[] from it.
 * Returns null if no tabs are currently grouped in Chrome.
 */
async function buildGroupsFromChrome(tabs: chrome.tabs.Tab[]): Promise<GroupedTabs[] | null> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return null if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return null
  const groupedTabs = tabs.filter((t) => t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE)
  if (groupedTabs.length === 0) return null

  // Collect unique group IDs
  const groupIds = [...new Set(groupedTabs.map((t) => t.groupId))]

  // Query Chrome for group metadata (title, color)
  const chromeGroups = new Map<number, chrome.tabGroups.TabGroup>()
  const windowId = tabs[0]?.windowId
  if (windowId !== undefined && typeof chrome.tabGroups.query === 'function') {
    try {
      const allWinGroups = await chrome.tabGroups.query({ windowId })
      const groupIdSet = new Set(groupIds)
      for (const g of allWinGroups) {
        if (groupIdSet.has(g.id)) {
          chromeGroups.set(g.id, g)
        }
      }
    } catch {
      // Fallback to Promise.all below if query fails
    }
  }

  if (chromeGroups.size === 0) {
    await Promise.all(
      groupIds.map(async (gid) => {
        try {
          const group = await chrome.tabGroups.get(gid)
          chromeGroups.set(gid, group)
        } catch {
          // Group may have been removed
        }
      })
    )
  }

  if (chromeGroups.size === 0) return null

  // Build GroupedTabs from Chrome state
  const result: GroupedTabs[] = []

  // 1. Separate Pinned tabs
  const pinnedTabs = tabs.filter((t) => t.pinned)
  const pinnedInfos = pinnedTabs
    .map((t) => chromeTabToTabInfo(t))
    .filter((t): t is TabInfo => t !== null)

  if (pinnedInfos.length > 0) {
    result.push({
      category: 'other' as GroupCategory,
      tabs: pinnedInfos,
      groupName: 'Pinned',
      isPinnedGroup: true,
    })
  }

  // 2. Build Chrome tab groups
  for (const [gid, chromeGroup] of chromeGroups) {
    const memberTabs = tabs.filter((t) => t.groupId === gid)
    const tabInfos = memberTabs
      .map((t) => chromeTabToTabInfo(t))
      .filter((t): t is TabInfo => t !== null)

    if (tabInfos.length === 0) continue

    result.push({
      category: 'other' as GroupCategory,
      tabs: tabInfos,
      groupName: chromeGroup.title || groupTitleMap.get(gid) || undefined,
      groupColor: (chromeGroup.color as ChromeTabGroupColor) || 'grey',
      groupId: gid,
    })
  }

  // 3. Add unpinned ungrouped tabs as a separate '_ungrouped_' group
  const unpinnedUngroupedTabs = tabs.filter(
    (t) => !t.pinned && (t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE),
  )
  const unpinnedUngroupedInfos = unpinnedUngroupedTabs
    .map((t) => chromeTabToTabInfo(t))
    .filter((t): t is TabInfo => t !== null)

  if (unpinnedUngroupedInfos.length > 0) {
    result.push({
      category: 'other' as GroupCategory,
      tabs: unpinnedUngroupedInfos,
      groupName: '_ungrouped_',
    })
  }

  return result
}

export function sortTabsByDomainAndTitleHelper(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
  const decorated = tabs.map((tab) => ({
    tab,
    domain: extractDomain(tab.url || ''),
    title: (tab.title || '').toLowerCase(),
  }))
  decorated.sort((a, b) => {
    const comp = a.domain.localeCompare(b.domain)
    if (comp !== 0) return comp
    return a.title.localeCompare(b.title)
  })
  return decorated.map((item) => item.tab)
}

// --- Public API ---

/**
 * Get all tabs in the given window, classify them, and return a preview.
 * Returns cached result when available. Pass forceRefresh=true to rebuild
 * (uses AI if enabled, otherwise rule engine).
 *
 * When cache is empty (e.g. service worker restarted), first checks if Chrome
 * already has tab groups and restores from those — this preserves AI grouping
 * results across service worker restarts.
 */
function buildDefaultUngroupedResult(tabs: chrome.tabs.Tab[]): GroupedTabs[] {
  const result: GroupedTabs[] = []
  const pinnedTabs = tabs.filter((t) => t.pinned)
  const unpinnedTabs = tabs.filter((t) => !t.pinned)

  if (pinnedTabs.length > 0) {
    const pinnedInfos = pinnedTabs
      .map((t) => chromeTabToTabInfo(t))
      .filter((t): t is TabInfo => t !== null)
    if (pinnedInfos.length > 0) {
      result.push({
        category: 'other' as GroupCategory,
        groupName: 'Pinned',
        isPinnedGroup: true,
        tabs: pinnedInfos,
      })
    }
  }

  if (unpinnedTabs.length > 0) {
    const unpinnedInfos = unpinnedTabs
      .map((t) => chromeTabToTabInfo(t))
      .filter((t): t is TabInfo => t !== null)
    if (unpinnedInfos.length > 0) {
      result.push({
        category: 'other' as GroupCategory,
        groupName: '_ungrouped_',
        tabs: unpinnedInfos,
      })
    }
  }

  return result
}

export async function getGroupsPreview(windowId: number, forceRefresh = false): Promise<GroupedTabs[]> {
  const cached = previewCacheMap.get(windowId)
  if (cached && !forceRefresh) return cached

  const tabs = await chrome.tabs.query({ windowId })

  if (!isTabGroupsSupported()) {
    const sorted = buildDefaultUngroupedResult(tabs)
    previewCacheMap.set(windowId, sorted)
    return sorted
  }

  const settings = await getSettings()

  let result: GroupedTabs[]

  if (forceRefresh && settings.ai.enabled && settings.ai.apiKey) {
    try {
      await setAIBadge()
      const tabsWithTime = tabs.map((t) => ({
        ...t,
        createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
      }))
      const freeGroups = await groupTabsFreelyWithAI(tabsWithTime, settings.ai)
      result = freeGroupsToGroupedTabs(freeGroups, tabs)
      cacheIsAIGroupedMap.set(windowId, true)
    } catch (err) {
      if (settings.ai.fallbackToSort) {
        console.error('[timTabTool] AI free grouping failed in preview, falling back to tab sorting. Error:', err)
        const unpinnedTabs = tabs.filter((t) => !t.pinned)
        const pinnedTabs = tabs.filter((t) => t.pinned)
        const sortedUnpinned = sortTabsByDomainAndTitleHelper(unpinnedTabs)
        const allSorted = [...pinnedTabs, ...sortedUnpinned]
        result = buildDefaultUngroupedResult(allSorted)
      } else {
        console.error('[timTabTool] AI free grouping failed in preview, keeping current tab groups untouched. Error:', err)
        const fromChrome = await buildGroupsFromChrome(tabs)
        result = fromChrome || buildDefaultUngroupedResult(tabs)
      }
      cacheIsAIGroupedMap.set(windowId, false)
    } finally {
      debouncedUpdateNewTabsBadge(windowId)
    }
  } else {
    const fromChrome = await buildGroupsFromChrome(tabs)
    if (fromChrome) {
      result = fromChrome
      cacheIsAIGroupedMap.set(windowId, fromChrome.some((g) => !!g.groupName))
    } else {
      if (settings.showRuleGroupsWhenUngrouped === false) {
        result = buildDefaultUngroupedResult(tabs)
      } else {
        result = ruleGroupsToGroupedTabs(classifyTabs(tabs), tabs)
      }
      cacheIsAIGroupedMap.set(windowId, false)
    }
  }

  const sorted = sortGroups(result)
  previewCacheMap.set(windowId, sorted)
  return sorted
}

/**
 * Group all tabs in the given window using Chrome Tab Groups API.
 * @param {number} windowId - The target window ID.
 * @param {Partial<ExtensionSettings['ai']>} [aiOverrides] - Optional AI configuration overrides.
 * @returns {Promise<void>}
 */
export async function groupAllTabs(windowId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
  // Logic: Throw an error if tab groups are not supported in the browser
  // Programming logic: Throw error if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) {
    throw new Error('Tab grouping is not supported in this browser.')
  }
  const existing = activeAbortControllers.get(windowId)
  if (existing) {
    existing.abort()
  }

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'group', error: null })

  try {
    const tabs = await chrome.tabs.query({ windowId, windowType: 'normal' })
    const unpinnedTabs = tabs.filter((t) => !t.pinned)

    let settings = await getSettings()
    if (aiOverrides) {
      settings = {
        ...settings,
        ai: {
          ...settings.ai,
          ...aiOverrides,
        }
      }
    }

    const hideTitles = titlesHiddenMap.get(windowId) ?? false
    let aiError: Error | null = null

    const initialGroups = isTabGroupsSupported() ? await chrome.tabGroups.query({ windowId }) : []
    const groupsBefore = initialGroups.length

    if (settings.ai.enabled && settings.ai.apiKey) {
      let logger: AILogger | undefined
      const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
      const isShift = Boolean(aiOverrides && ((aiOverrides as any).shiftKey || (aiOverrides as any).verboseLog))
      const shouldLog = alwaysLog || isShift
      if (shouldLog) {
        logger = await AILogger.create({
          actionType: 'GROUP_TABS',
          triggeredWithShift: isShift,
          config: settings.ai,
          tabsInput: unpinnedTabs.map((t, idx) => ({ index: idx + 1, title: t.title || '', url: t.url, groupId: t.groupId })),
          prompts: {
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: settings.ai.groupingPrompt,
            customPrompt: settings.ai.customPrompt,
            coherencePrompt: settings.ai.coherencePrompt,
          },
          windowId,
        })
        const est = AIClient.estimateCostAndTokens(settings.ai, unpinnedTabs.length, 'group')
        logger.recordTokenEstimate(est.tokens, 0, est.costStr)
        registerTimeoutLogger(windowId, logger)
      }

      try {
        await setAIBadge()
        // Make the AI call first while tabs are untouched
        const unpinnedTabsWithTime = unpinnedTabs.map((t) => ({
          ...t,
          createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
        }))
        const freeGroups = await groupTabsFreelyWithAI(unpinnedTabsWithTime, settings.ai, controller.signal, logger, (current, total) => {
          updateOperationProgress(windowId, {
            batchCurrent: current,
            batchTotal: total,
            statusText: 'Processing...'
          })
        })
        if (controller.signal.aborted) {
          if (logger) await logger.markFailed(new Error('Operation aborted by user'))
          return
        }

        // AI succeeded! We can now ungroup all tabs and apply AI groups safely
        await ungroupAllTabs(windowId)

        // Bulk move tabs into sorted order before grouping to prevent UI freezing
        const orderedTabIds = freeGroups.flatMap((g) => g.tabIds)
        const pinnedCount = tabs.length - unpinnedTabs.length
        if (orderedTabIds.length > 0) {
          await retryTabOperation(() => chrome.tabs.move(orderedTabIds, { index: pinnedCount }))
        }

        for (const group of freeGroups) {
          if (controller.signal.aborted) return
          if (group.tabIds.length === 0) continue
          if (group.name === '_ungrouped_') continue // Leave tabs ungrouped instead of creating a literal "_ungrouped_" group

          const groupId = await retryTabOperation(() =>
            chrome.tabs.group({
              tabIds: group.tabIds as [number, ...number[]],
              createProperties: { windowId },
            }),
          )
          if (groupId === undefined) continue
          
          groupTitleMap.set(groupId, group.name)
          await retryTabOperation(() =>
            chrome.tabGroups.update(groupId, {
              title: hideTitles ? '' : group.name,
              color: group.color,
            }),
          )
        }
        previewCacheMap.set(windowId, sortGroups(freeGroupsToGroupedTabs(freeGroups, tabs)))
        cacheIsAIGroupedMap.set(windowId, true)
        debouncedUpdateNewTabsBadge(windowId)
        activeOperationsMap.delete(windowId)

        const finalGroups = isTabGroupsSupported() ? await chrome.tabGroups.query({ windowId }) : []
        const groupsAfter = finalGroups.length
        if (logger) {
          await logger.markCompleted({
            createdGroupsCount: freeGroups.length,
            createdGroupNames: freeGroups.map((g) => g.name),
            groupsBefore,
            groupsAfter,
            summary: `${unpinnedTabs.length} tabs → ${freeGroups.length} groups (${groupsBefore} → ${groupsAfter})`,
          })
        }
        const lastResult: LastAIResult = {
          timestamp: Date.now(),
          actionType: 'group',
          actionTitle: 'AI Tab Grouping',
          windowId,
          tabsProcessed: unpinnedTabs.length,
          groupsBefore,
          groupsAfter,
          createdGroupNames: freeGroups.map((g) => g.name),
          summary: `${unpinnedTabs.length} tabs → ${freeGroups.length} groups (${groupsBefore} → ${groupsAfter})`,
        }
        await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
        chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
        return
      } catch (err) {
        if (logger) {
          await logger.markFailed(err)
        }
        if (controller.signal.aborted) {
          console.log('[timTabTool] Grouping aborted by user')
          return
        }
        aiError = err as Error
        if (settings.ai.fallbackToSort) {
          console.error('[timTabTool] AI free grouping failed, falling back to tab sorting. Error:', err)
          await ungroupAllTabs(windowId)
          const sortedUnpinned = sortTabsByDomainAndTitleHelper(unpinnedTabs)
          const tabIds = sortedUnpinned.map((t) => t.id).filter((id): id is number => id !== undefined)
          if (tabIds.length > 0) {
            const pinnedCount = tabs.length - unpinnedTabs.length
            await retryTabOperation(() => chrome.tabs.move(tabIds, { index: pinnedCount }))
          }
          const freshTabs = await chrome.tabs.query({ windowId })
          const tabInfos = freshTabs
            .map((t) => chromeTabToTabInfo(t))
            .filter((t): t is TabInfo => t !== null)
          previewCacheMap.set(windowId, [
            {
              category: 'other' as GroupCategory,
              tabs: tabInfos,
            },
          ])
          cacheIsAIGroupedMap.set(windowId, false)
          debouncedUpdateNewTabsBadge(windowId)
          const finalErr = new Error(`AI Grouping failed: ${aiError.message}. Fell back to sorting tabs.`)
          activeOperationsMap.set(windowId, { type: null, error: finalErr.message })
          throw finalErr
        }
        console.error('[timTabTool] AI free grouping failed, no fallback enabled. Error:', err)
        const finalErr = new Error(`AI Grouping failed: ${aiError.message}`)
        activeOperationsMap.set(windowId, { type: null, error: finalErr.message })
        throw finalErr
      }
    }

    // --- Offline Rule Engine Grouping ---
    // If AI is disabled or fallback is not running, we only ungroup and apply rule-based grouping here
    await ungroupAllTabs(windowId)

    if (controller.signal.aborted) return

    const groups = classifyTabs(unpinnedTabs)
    
    // Bulk move tabs into sorted order before grouping to prevent UI freezing
    const orderedTabIds: number[] = []
    for (const tabIds of groups.values()) {
      orderedTabIds.push(...tabIds)
    }
    const pinnedCount = tabs.length - unpinnedTabs.length
    if (orderedTabIds.length > 0) {
      await retryTabOperation(() => chrome.tabs.move(orderedTabIds, { index: pinnedCount }))
    }

    for (const [category, tabIds] of groups) {
      if (controller.signal.aborted) return
      if (tabIds.length === 0) continue

      const def = GROUP_DEFINITIONS[category]
      const title = getMessage(def.labelKey)
      const shouldCollapse = category === 'other'
      const groupId = await retryTabOperation(() =>
        chrome.tabs.group({
          tabIds: tabIds as [number, ...number[]],
          createProperties: { windowId },
        }),
      )
      groupTitleMap.set(groupId, title)

      updatingGroups.add(groupId)
      await retryTabOperation(() =>
        chrome.tabGroups.update(groupId, {
          title: hideTitles ? '' : title,
          color: def.color,
          collapsed: shouldCollapse,
        }),
      )
      updatingGroups.delete(groupId)
    }
    previewCacheMap.set(windowId, sortGroups(ruleGroupsToGroupedTabs(groups, tabs)))
    cacheIsAIGroupedMap.set(windowId, false)
    debouncedUpdateNewTabsBadge(windowId)
    activeOperationsMap.delete(windowId)
  } catch (err) {
    if (controller.signal.aborted) return
    activeOperationsMap.set(windowId, { type: null, error: (err as Error).message })
    throw err
  } finally {
    clearOperationTimeout(windowId)
    debouncedUpdateNewTabsBadge(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'group') {
      activeOperationsMap.delete(windowId)
    }
  }
}

/**
 * Classify new tabs (ungrouped tabs) into existing AI groups.
 * Uses AI to decide which group each tab belongs to, then moves them.
 * @param {number} windowId - The target window ID.
 * @param {Partial<ExtensionSettings['ai']>} [aiOverrides] - Optional AI config overrides.
 * @returns {Promise<void>}
 */
export async function classifyNewTabs(windowId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
  // Logic: Throw an error if tab groups are not supported in the browser
  // Programming logic: Throw error if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) {
    throw new Error('Tab grouping is not supported in this browser.')
  }
  const existing = activeAbortControllers.get(windowId)
  if (existing) {
    existing.abort()
  }

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'classify', error: null })

  try {
    let settings = await getSettings()
    if (aiOverrides) {
      settings = {
        ...settings,
        ai: {
          ...settings.ai,
          ...aiOverrides,
        }
      }
    }
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured')
    }

    const allTabs = await chrome.tabs.query({ windowId })
    const allGroups = await chrome.tabGroups.query({ windowId })

    // Logik: Klassifiziert alle ungruppierten Tabs
    // Include completely ungrouped tabs (excluding pinned tabs)
    const newTabs = allTabs.filter((t) => {
      if (t.id === undefined || t.pinned) return false
      return t.groupId === TAB_GROUP_ID_NONE
    })
    if (newTabs.length === 0) return

    // Build existing group name → groupId mapping
    const groupNameToId = new Map<string, number>()
    for (const g of allGroups) {
      const name = groupTitleMap.get(g.id) || g.title
      if (name) groupNameToId.set(name, g.id)
    }

    const existingGroupNames = [...groupNameToId.keys()]

    let logger: AILogger | undefined
    const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
    const isShift = Boolean(aiOverrides && ((aiOverrides as any).shiftKey || (aiOverrides as any).verboseLog))
    const shouldLog = alwaysLog || isShift
    if (shouldLog) {
      logger = await AILogger.create({
        actionType: 'CLASSIFY_NEW_TABS',
        triggeredWithShift: isShift,
        config: settings.ai,
        tabsInput: newTabs.map((t, idx) => ({ index: idx + 1, title: t.title || '', url: t.url, groupId: t.groupId })),
        prompts: {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: settings.ai.classifyPrompt,
          customPrompt: settings.ai.customPrompt,
        },
        windowId,
      })
      const est = AIClient.estimateCostAndTokens(settings.ai, newTabs.length, 'classify', undefined, undefined, existingGroupNames)
      logger.recordTokenEstimate(est.tokens, 0, est.costStr)
      registerTimeoutLogger(windowId, logger)
    }

    await setAIBadge()
    const client = new AIClient(settings.ai, controller.signal, logger)
    let classifications
    try {
      classifications = await client.classifyNewTabsIntoGroups(
        newTabs.map((t) => ({
          url: t.url || '',
          title: t.title || '',
          lastAccessed: t.lastAccessed,
          createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
        })),
        existingGroupNames,
        false,
        (current, total) => {
          updateOperationProgress(windowId, {
            batchCurrent: current,
            batchTotal: total,
            statusText: 'Processing...'
          })
        }
      )
    } catch (classifyErr) {
      if (logger) await logger.markFailed(classifyErr)
      throw classifyErr
    }

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return
    }

    if (logger) {
      await logger.markCompleted({
        summary: `Classified ${newTabs.length} tabs into existing/new groups`,
      })
    }

    const hideTitles = titlesHiddenMap.get(windowId) ?? false

    // Group tabs by destination to minimize API calls
    const existingGroupUpdates = new Map<number, number[]>() // groupId -> tabIds
    const newGroupUpdates = new Map<string, { tabIds: number[], color: ChromeTabGroupColor }>() // groupName -> {tabIds, color}

    for (const item of classifications) {
      const tab = newTabs[item.index]
      if (!tab?.id) continue

      if (item.group !== 'NEW' && groupNameToId.has(item.group)) {
        const targetGroupId = groupNameToId.get(item.group)!
        if (!existingGroupUpdates.has(targetGroupId)) existingGroupUpdates.set(targetGroupId, [])
        existingGroupUpdates.get(targetGroupId)!.push(tab.id)
      } else {
        const name = item.newGroupName || '_ungrouped_'
        const color = (item.newGroupColor as ChromeTabGroupColor) || 'grey'
        
        if (name === '_ungrouped_') continue // They are already ungrouped, just skip
        
        if (groupNameToId.has(name)) {
          const targetGroupId = groupNameToId.get(name)!
          if (!existingGroupUpdates.has(targetGroupId)) existingGroupUpdates.set(targetGroupId, [])
          existingGroupUpdates.get(targetGroupId)!.push(tab.id)
        } else {
          if (!newGroupUpdates.has(name)) newGroupUpdates.set(name, { tabIds: [], color })
          newGroupUpdates.get(name)!.tabIds.push(tab.id)
        }
      }
    }

    if (controller.signal.aborted) return

    // Filter out tabs that might have been closed during the AI operation
    const currentTabsForFilter = await chrome.tabs.query({ windowId })
    const currentTabIdsSet = new Set(currentTabsForFilter.map(t => t.id))

    // Apply updates for existing groups
    for (const [groupId, tabIds] of existingGroupUpdates) {
      if (controller.signal.aborted) return
      const validTabIds = tabIds.filter(id => currentTabIdsSet.has(id))
      if (validTabIds.length === 0) continue
      
      // Move tabs adjacent to the existing group first to prevent Chrome layout freezing/crashing
      // which can destroy existing groups.
      const groupTabs = await chrome.tabs.query({ groupId })
      if (groupTabs.length > 0) {
        await retryTabOperation(() => chrome.tabs.move(validTabIds, { index: groupTabs[groupTabs.length - 1].index + 1 }))
      }
      
      await retryTabOperation(() => chrome.tabs.group({ tabIds: validTabIds as [number, ...number[]], groupId }))
    }

    // For new groups, we can bulk move them first so they are adjacent
    const orderedNewTabIds = Array.from(newGroupUpdates.values())
      .flatMap(g => g.tabIds)
      .filter(id => currentTabIdsSet.has(id))
      
    if (orderedNewTabIds.length > 0) {
      const pinnedCount = currentTabsForFilter.filter((t) => t.pinned).length
      await retryTabOperation(() => chrome.tabs.move(orderedNewTabIds, { index: pinnedCount }))
    }

    // Create new groups
    for (const [name, data] of newGroupUpdates) {
      if (controller.signal.aborted) return
      const validTabIds = data.tabIds.filter(id => currentTabIdsSet.has(id))
      if (validTabIds.length === 0) continue
      const groupId = await retryTabOperation(() =>
        chrome.tabs.group({
          tabIds: validTabIds as [number, ...number[]],
          createProperties: { windowId },
        }),
      )
      if (groupId === undefined) continue
      groupTitleMap.set(groupId, name)
      groupNameToId.set(name, groupId)
      updatingGroups.add(groupId)
      try {
        await retryTabOperation(() =>
          chrome.tabGroups.update(groupId, {
            title: hideTitles ? '' : name,
            color: data.color,
          }),
        )
      } finally {
        updatingGroups.delete(groupId)
      }
    }

    // Rebuild preview cache and clear badge
    invalidatePreviewCache(windowId)
    await getGroupsPreview(windowId)
    debouncedUpdateNewTabsBadge(windowId)
    activeOperationsMap.delete(windowId)

    const finalGroups = isTabGroupsSupported() ? await chrome.tabGroups.query({ windowId }) : []
    const groupsAfter = finalGroups.length

    const targetGroupTitles: string[] = []
    if (isTabGroupsSupported()) {
      for (const groupId of existingGroupUpdates.keys()) {
        try {
          const g = await chrome.tabGroups.get(groupId)
          const title = g.title || groupTitleMap.get(groupId) || 'Group'
          targetGroupTitles.push(title)
        } catch {
          const title = groupTitleMap.get(groupId) || 'Group'
          targetGroupTitles.push(title)
        }
      }
    }
    const categorizedNames = Array.from(new Set([
      ...targetGroupTitles,
      ...Array.from(newGroupUpdates.keys())
    ]))
    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'classify',
      actionTitle: 'AI Tab Classification',
      windowId,
      tabsProcessed: newTabs.length,
      groupsBefore: allGroups.length,
      groupsAfter,
      createdGroupNames: categorizedNames,
      summary: `${newTabs.length} new tabs classified`,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
  } catch (err) {
    if (controller.signal.aborted) {
      console.log('[timTabTool] Classification aborted by user')
      return
    }
    activeOperationsMap.set(windowId, { type: null, error: (err as Error).message })
    throw err
  } finally {
    clearOperationTimeout(windowId)
    debouncedUpdateNewTabsBadge(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'classify') {
      activeOperationsMap.delete(windowId)
    }
  }
}

/**
 * Close all tabs in a group by their IDs and remove them from cache.
 */
export async function closeGroupTabs(tabIds: number[]): Promise<void> {
  if (tabIds.length === 0) return
  try {
    await chrome.tabs.remove(tabIds)
  } catch (err: any) {
    const errMsg = err?.message || String(err)
    if (!errMsg.includes('No tab with id') && !errMsg.includes('Invalid tab id')) {
      console.error('[timTabTool] Failed to close group tabs:', err)
    }
  }
  for (const id of tabIds) {
    cacheRemoveTab(id)
  }
}

/**
 * Split a single tab group into more specific sub-groups using AI.
 * @param {number} groupId - The ID of the group to split.
 * @param {Partial<ExtensionSettings['ai']>} [aiOverrides] - Optional AI config overrides.
 * @returns {Promise<void>}
 */
export async function splitGroup(groupId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
  // Logic: Throw an error if tab groups are not supported in the browser
  // Programming logic: Throw error if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) {
    throw new Error('Tab grouping is not supported in this browser.')
  }
  let windowId: number
  try {
    const group = await chrome.tabGroups.get(groupId)
    windowId = group.windowId
  } catch (err) {
    const currentWin = await chrome.windows.getCurrent()
    windowId = currentWin.id || chrome.windows.WINDOW_ID_NONE
  }

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'group', error: null })

  try {
    const group = await chrome.tabGroups.get(groupId)
    const tabs = await chrome.tabs.query({ groupId })
    if (tabs.length === 0) {
      throw new Error('No active tabs found in target group to split.')
    }

    const settings = await getSettings()
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured. Please enable and configure AI in Settings first.')
    }

    const hideTitles = titlesHiddenMap.get(windowId) ?? false

    await setAIBadge()
    // Query AI for sub-grouping
    const tabInputs = tabs.map((t) => ({
      url: t.url || '',
      title: t.title || '',
      lastAccessed: t.lastAccessed,
      createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
    }))
    
    // Query other existing tab groups in this window for context
    const allGroups = await chrome.tabGroups.query({ windowId })
    const otherGroupNames = allGroups
      .filter((g) => g.id !== groupId)
      .map((g) => groupTitleMap.get(g.id) || g.title)
      .filter((title): title is string => Boolean(title?.trim()))

    // Append a context instruction to settings.ai.splitPrompt to guide the AI to split this specific group
    let splitPrompt = `${settings.ai.splitPrompt || 'You are splitting an existing group of highly related tabs. Create more specific and granular sub-groups based on finer details and relationships.'}`
    if (otherGroupNames.length > 0) {
      splitPrompt += `\n\nOther existing tab groups in this window for context: ${otherGroupNames.map(name => `"${name}"`).join(', ')}. Create distinct, specific sub-group names that complement these existing groups.`
    }
    
    let logger: AILogger | undefined
    const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
    const isShift = Boolean(aiOverrides && ((aiOverrides as any).shiftKey || (aiOverrides as any).verboseLog))
    const shouldLog = alwaysLog || isShift
    if (shouldLog) {
      logger = await AILogger.create({
        actionType: 'SPLIT_GROUP',
        triggeredWithShift: isShift,
        config: settings.ai,
        tabsInput: tabs.map((t, idx) => ({ index: idx + 1, title: t.title || '', url: t.url, groupId: t.groupId })),
        prompts: {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: splitPrompt,
        },
        windowId,
      })
      const est = AIClient.estimateCostAndTokens(settings.ai, tabs.length, 'split')
      logger.recordTokenEstimate(est.tokens, 0, est.costStr)
      registerTimeoutLogger(windowId, logger)
    }

    const client = new AIClient({
      ...settings.ai,
      ...aiOverrides,
      groupingPrompt: splitPrompt
    }, controller.signal, logger)

    const subGroups = await client.groupTabsFreely(tabInputs, otherGroupNames)

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return
    }

    // Explicitly ungroup ALL tabs from the original group before applying new groups.
    // This prevents Chrome from breaking unrelated groups due to internal grouping bugs when re-grouping sorted tabs.
    const allTabIds = tabs.map(t => t.id).filter((id): id is number => id !== undefined)
    if (allTabIds.length > 0) {
      await retryTabOperation(() => chrome.tabs.ungroup(allTabIds as [number, ...number[]]))
    }

    // Apply the sub-groups to Chrome
    for (const subGroup of subGroups) {
      if (controller.signal.aborted) return
      if (subGroup.tabIndices.length === 0) continue

      const realTabIds = subGroup.tabIndices
        .map((idx) => tabs[idx - 1]?.id) // AI Client uses 1-based index
        .filter((id): id is number => id !== undefined)

      if (realTabIds.length === 0) continue

      if (subGroup.name === '_ungrouped_') {
        // Explicitly ungroup these tabs so they don't get stuck in the original group
        await retryTabOperation(() => chrome.tabs.ungroup(realTabIds as [number, ...number[]]))
        continue 
      }

      const newGroupId = await retryTabOperation(() =>
        chrome.tabs.group({
          tabIds: realTabIds as [number, ...number[]],
          createProperties: { windowId },
        })
      )

      groupTitleMap.set(newGroupId, subGroup.name)
      await retryTabOperation(() =>
        chrome.tabGroups.update(newGroupId, {
          title: hideTitles ? '' : subGroup.name,
          color: subGroup.color || 'grey',
        })
      )
    }

    if (logger) {
      await logger.markCompleted({
        createdGroupsCount: subGroups.length,
        createdGroupNames: subGroups.map(g => g.name),
        summary: `Split group into ${subGroups.length} sub-groups`,
      })
    }

    // Rebuild cache
    invalidatePreviewCache(windowId)
    await getGroupsPreview(windowId)
    activeOperationsMap.delete(windowId)
  } catch (err) {
    console.error('[timTabTool] splitGroup failed:', err)
    activeOperationsMap.set(windowId, { type: null, error: (err as Error).message })
    throw err
  } finally {
    clearOperationTimeout(windowId)
    debouncedUpdateNewTabsBadge(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'group') {
      activeOperationsMap.delete(windowId)
    }
  }
}

/**
 * Merge a single tab group into another existing tab group using AI.
 */
export async function mergeGroup(groupId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
  // Logic: Throw an error if tab groups are not supported in the browser
  // Programming logic: Throw error if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) {
    throw new Error('Tab grouping is not supported in this browser.')
  }
  let windowId: number
  try {
    const group = await chrome.tabGroups.get(groupId)
    windowId = group.windowId
  } catch (err) {
    const currentWin = await chrome.windows.getCurrent()
    windowId = currentWin.id || chrome.windows.WINDOW_ID_NONE
  }

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'group', error: null })

  try {
    const group = await chrome.tabGroups.get(groupId)
    const tabs = await chrome.tabs.query({ groupId })
    if (tabs.length === 0) {
      throw new Error('No active tabs found in target group to merge.')
    }

    const settings = await getSettings()
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured. Please enable and configure AI in Settings first.')
    }

    // Query other groups in this window
    const allGroups = await chrome.tabGroups.query({ windowId })
    const otherGroups = allGroups.filter((g) => g.id !== groupId)

    if (otherGroups.length === 0) {
      throw new Error('No other groups in this window to merge into.')
    }

    // Map group name -> other group ID
    const groupNameToId = new Map<string, number>()
    for (const g of otherGroups) {
      const name = groupTitleMap.get(g.id) || g.title
      if (name) groupNameToId.set(name, g.id)
    }

    const otherGroupNames = [...groupNameToId.keys()]
    if (otherGroupNames.length === 0) {
      throw new Error('No other named groups in this window to merge into.')
    }

    // Query AI for merging
    const tabInputs = tabs.map((t) => ({
      url: t.url || '',
      title: t.title || '',
      lastAccessed: t.lastAccessed,
      createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
    }))
    let logger: AILogger | undefined
    const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
    const isShift = Boolean(aiOverrides && ((aiOverrides as any).shiftKey || (aiOverrides as any).verboseLog))
    const shouldLog = alwaysLog || isShift
    if (shouldLog) {
      logger = await AILogger.create({
        actionType: 'MERGE_GROUP',
        triggeredWithShift: isShift,
        config: settings.ai,
        tabsInput: tabs.map((t, idx) => ({ index: idx + 1, title: t.title || '', url: t.url, groupId: t.groupId })),
        prompts: {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: settings.ai.mergePrompt,
        },
        windowId,
      })
      const est = AIClient.estimateCostAndTokens(settings.ai, tabs.length, 'merge', undefined, undefined, otherGroupNames)
      logger.recordTokenEstimate(est.tokens, 0, est.costStr)
      registerTimeoutLogger(windowId, logger)
    }

    const client = new AIClient({
      ...settings.ai,
      ...aiOverrides
    }, controller.signal, logger)
    
    await setAIBadge()
    let mergeTarget
    try {
      mergeTarget = await client.decideMergeGroup(tabInputs, otherGroupNames)
    } catch (mergeErr) {
      if (logger) await logger.markFailed(mergeErr)
      throw mergeErr
    }

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return
    }

    if (logger) {
      await logger.markCompleted({
        summary: mergeTarget === 'KEEP' ? 'AI decided to KEEP group separate' : `Merged group into "${mergeTarget}"`,
      })
    }

    if (mergeTarget !== 'KEEP' && groupNameToId.has(mergeTarget)) {
      const targetGroupId = groupNameToId.get(mergeTarget)!
      const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
      
      if (tabIds.length > 0) {
        const targetTabs = await chrome.tabs.query({ groupId: targetGroupId })
        if (targetTabs.length > 0) {
          const targetIndex = targetTabs[targetTabs.length - 1].index + 1
          await retryTabOperation(() => chrome.tabs.move(tabIds, { index: targetIndex }))
        }
        await retryTabOperation(() =>
          chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId: targetGroupId })
        )
      }
    }

    // Rebuild cache
    invalidatePreviewCache(windowId)
    await getGroupsPreview(windowId)
    activeOperationsMap.delete(windowId)
  } catch (err) {
    console.error('[timTabTool] mergeGroup failed:', err)
    activeOperationsMap.set(windowId, { type: null, error: (err as Error).message })
    throw err
  } finally {
    clearOperationTimeout(windowId)
    debouncedUpdateNewTabsBadge(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'group') {
      activeOperationsMap.delete(windowId)
    }
  }
}



/**
 * Cancel any running AI-enhanced grouping or classification for this window.
 */
export function cancelActiveOperation(windowId: number): void {
  const controller = activeAbortControllers.get(windowId)
  if (controller) {
    controller.abort()
    activeAbortControllers.delete(windowId)
  }
  activeOperationsMap.delete(windowId)
}

/**
 * Set collapsed state on all Chrome tab groups in the given window.
 */
async function setAllGroupsCollapsed(windowId: number, collapsed: boolean): Promise<void> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return early if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return
  const tabs = await chrome.tabs.query({ windowId })
  const groupIds = [
    ...new Set(
      tabs
        .filter((t) => t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE)
        .map((t) => t.groupId),
    ),
  ]
  for (const groupId of groupIds) {
    updatingGroups.add(groupId)
    try {
      await retryTabOperation(() =>
        chrome.tabGroups.update(groupId, { collapsed }),
      )
    } catch (err) {
      console.error(`[timTabTool] Failed to update group ${groupId} collapsed=${collapsed}:`, err)
    } finally {
      updatingGroups.delete(groupId)
    }
  }
}

export async function expandAllGroups(windowId: number): Promise<void> {
  await setAllGroupsCollapsed(windowId, false)
}

export async function collapseAllGroups(windowId: number): Promise<void> {
  await setAllGroupsCollapsed(windowId, true)
}

export function areGroupTitlesHidden(windowId: number): boolean {
  return titlesHiddenMap.get(windowId) ?? false
}

/**
 * Toggle group title visibility in the Chrome tab bar.
 * When hidden, group labels shrink to minimal colored dots.
 * Returns the new hidden state.
 */
export async function toggleGroupTitles(windowId: number): Promise<boolean> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return false if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return false
  const isHidden = titlesHiddenMap.get(windowId) ?? false
  const tabs = await chrome.tabs.query({ windowId })
  const groupIds = [
    ...new Set(
      tabs
        .filter((t) => t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE)
        .map((t) => t.groupId),
    ),
  ]

  for (const groupId of groupIds) {
    if (isHidden) {
      const savedTitle = groupTitleMap.get(groupId)
      if (!savedTitle) continue
      updatingGroups.add(groupId)
      try {
        await retryTabOperation(() =>
          chrome.tabGroups.update(groupId, { title: savedTitle }),
        )
      } catch (err) {
        console.error(`[timTabTool] Failed to restore title for group ${groupId}:`, err)
      } finally {
        updatingGroups.delete(groupId)
      }
    } else {
      if (!groupTitleMap.has(groupId)) {
        try {
          const g = await chrome.tabGroups.get(groupId)
          if (g.title) groupTitleMap.set(groupId, g.title)
        } catch {
          // Group may have been removed
        }
      }
      updatingGroups.add(groupId)
      try {
        await retryTabOperation(() =>
          chrome.tabGroups.update(groupId, { title: '' }),
        )
      } catch (err) {
        console.error(`[timTabTool] Failed to hide title for group ${groupId}:`, err)
      } finally {
        updatingGroups.delete(groupId)
      }
    }
  }

  const newState = !isHidden
  titlesHiddenMap.set(windowId, newState)
  return newState
}

/**
 * Ungroup all tabs in the given window.
 */
export async function ungroupAllTabs(windowId: number): Promise<void> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return early if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return
  const tabs = await chrome.tabs.query({ windowId })
  const tabIds = tabs
    .filter((t) => t.groupId !== TAB_GROUP_ID_NONE && t.id !== undefined)
    .map((t) => t.id!)

  if (tabIds.length > 0) {
    await retryTabOperation(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]))
  }
  await chrome.action.setBadgeText({ text: '' })
}

/**
 * Ungroup a specific set of tab IDs (dissolves the group) without closing the tabs.
 */
export async function ungroupGroupTabs(tabIds: number[]): Promise<void> {
  if (!isTabGroupsSupported() || tabIds.length === 0) return
  await retryTabOperation(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]))
  invalidatePreviewCache()
}

/**
 * Handle Chrome tab group update events for smart title toggling.
 * Always keep the full group title visible regardless of collapse state,
 * so the title is shown in the bookmarks bar on the new tab page.
 */
export async function handleTabGroupUpdated(group: chrome.tabGroups.TabGroup): Promise<void> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return early if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return
  if (updatingGroups.has(group.id)) return

  const hidden = titlesHiddenMap.get(group.windowId) ?? false
  if (hidden) {
    if (group.title !== '') {
      updatingGroups.add(group.id)
      try {
        await chrome.tabGroups.update(group.id, { title: '' })
      } catch {
        // Group may have been removed
      } finally {
        updatingGroups.delete(group.id)
      }
    }
    return
  }

  const settings = await getSettings()
  if (!settings.smartGroupTitle) return

  const savedTitle = groupTitleMap.get(group.id)
  if (!savedTitle) return

  if (group.title === savedTitle) return

  updatingGroups.add(group.id)
  try {
    await chrome.tabGroups.update(group.id, { title: savedTitle })
  } catch {
    // Group may have been removed
  } finally {
    updatingGroups.delete(group.id)
  }
}

/**
 * Clean up stored title mapping when a group is removed.
 */
export function handleTabGroupRemoved(groupId: number): void {
  groupTitleMap.delete(groupId)
  updatingGroups.delete(groupId)
}

// --- Window and Tab Management Utilities ---

export async function closeDuplicateTabs(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })
  const result = detectDuplicateTabs(tabs)
  const dupIds = result.exactDuplicates.map(t => t.id).filter((id): id is number => id !== undefined)

  if (dupIds.length > 0) {
    await chrome.tabs.remove(dupIds)
    for (const id of dupIds) cacheRemoveTab(id)
  }
}

export async function closePossibleDuplicateTabs(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })
  const result = detectDuplicateTabs(tabs)
  const dupIds: number[] = []

  for (const cluster of result.possibleDuplicates) {
    // Keep the first tab, remove all subsequent variant tabs
    for (let i = 1; i < cluster.tabs.length; i++) {
      const id = cluster.tabs[i].id
      if (id !== undefined) dupIds.push(id)
    }
  }

  if (dupIds.length > 0) {
    await chrome.tabs.remove(dupIds)
    for (const id of dupIds) cacheRemoveTab(id)
  }
}

export async function organizePossibleDuplicateGroups(targetWindowId?: number): Promise<void> {
  const queryFilter = targetWindowId !== undefined ? { windowId: targetWindowId } : {}
  const tabs = await chrome.tabs.query(queryFilter)
  const result = detectDuplicateTabs(tabs)

  if (result.possibleDuplicates.length === 0) return

  const colors: ChromeTabGroupColor[] = ['orange', 'yellow', 'pink', 'purple', 'cyan', 'blue']
  let colorIdx = 0

  for (const cluster of result.possibleDuplicates) {
    const tabIds = cluster.tabs.map(t => t.id).filter((id): id is number => id !== undefined)
    if (tabIds.length < 2) continue

    if (isTabGroupsSupported()) {
      try {
        const groupId = (await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] })) as unknown as number
        const groupTitle = `Dupes: ${cluster.domain || 'Cluster'}`
        const groupColor = colors[colorIdx % colors.length]
        colorIdx++

        await chrome.tabGroups.update(groupId, {
          title: groupTitle,
          color: groupColor
        })
      } catch (err) {
        console.error('[timTabTool] Failed to group possible duplicates:', err)
      }
    }
  }
}


export async function closeDomainTabs(windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId })
  if (!activeTab || !activeTab.url) return
  const activeDomain = extractDomain(activeTab.url)
  if (!activeDomain) return
  const tabs = await chrome.tabs.query({ windowId })
  const toClose: number[] = []
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue
    if (extractDomain(tab.url) === activeDomain) {
      toClose.push(tab.id)
    }
  }
  if (toClose.length > 0) {
    await chrome.tabs.remove(toClose)
    for (const id of toClose) cacheRemoveTab(id)
  }
}

export async function isolateDomainTabs(windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId })
  if (!activeTab || !activeTab.url) return
  const activeDomain = extractDomain(activeTab.url)
  if (!activeDomain) return
  const tabs = await chrome.tabs.query({ windowId })
  const toMove: number[] = []
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue
    if (extractDomain(tab.url) === activeDomain) {
      toMove.push(tab.id)
    }
  }
  if (toMove.length > 0) {
    const newWindow = await chrome.windows.create({ focused: true })
    if (newWindow && newWindow.id !== undefined) {
      const newTabId = newWindow.tabs?.[0]?.id
      await chrome.tabs.move(toMove, { windowId: newWindow.id, index: -1 })
      if (newTabId) await chrome.tabs.remove(newTabId)
    }
  }
}

export async function sortTabsByDomainAndTitle(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })

  // 1. Sort ungrouped unpinned tabs and move them to the end
  const ungrouped = tabs.filter((t) => !t.pinned && (t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE))
  if (ungrouped.length > 0) {
    const sorted = sortTabsByDomainAndTitleHelper(ungrouped)
    const tabIds = sorted.map((t) => t.id).filter((id): id is number => id !== undefined)
    await retryTabOperation(() => chrome.tabs.move(tabIds, { index: -1 }))
  }

  // 2. Sort tabs WITHIN each group
  const groupIds = [...new Set(tabs.map(t => t.groupId).filter(id => id !== undefined && id !== TAB_GROUP_ID_NONE))]
  for (const gid of groupIds) {
    const groupTabs = tabs.filter(t => t.groupId === gid)
    if (groupTabs.length > 0) {
      const sorted = sortTabsByDomainAndTitleHelper(groupTabs)
      const tabIds = sorted.map((t) => t.id).filter((id): id is number => id !== undefined)
      // Find the current starting index of this group to keep it in place
      const startIndex = Math.min(...groupTabs.map(t => t.index))
      await retryTabOperation(() => chrome.tabs.move(tabIds, { index: startIndex }))
    }
  }

  invalidatePreviewCache(windowId)
  debouncedUpdateNewTabsBadge(windowId)
}

/**
 * Sort tab groups in the given window alphabetically by name.
 */
export async function sortGroupsByName(windowId: number): Promise<void> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return early if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return
  const groups = await chrome.tabGroups.query({ windowId })
  if (groups.length <= 1) return

  const sortedGroups = [...groups].sort((a, b) => {
    const nameA = (a.title || groupTitleMap.get(a.id) || '').trim()
    const nameB = (b.title || groupTitleMap.get(b.id) || '').trim()
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true })
  })

  const tabs = await chrome.tabs.query({ windowId })
  const pinnedCount = tabs.filter((t) => t.pinned).length
  let currentIndex = pinnedCount

  for (const group of sortedGroups) {
    const memberTabs = tabs.filter((t) => t.groupId === group.id)
    const tabIds = memberTabs.map((t) => t.id).filter((id): id is number => id !== undefined)
    if (tabIds.length > 0) {
      await retryTabOperation(() => chrome.tabs.move(tabIds, { index: currentIndex }))
      currentIndex += tabIds.length
    }
  }

  invalidatePreviewCache(windowId)
}

/**
 * Sort tab groups in the given window by size (number of tabs, descending).
 */
export async function sortGroupsBySize(windowId: number): Promise<void> {
  if (!isTabGroupsSupported()) return
  const groups = await chrome.tabGroups.query({ windowId })
  if (groups.length <= 1) return

  const tabs = await chrome.tabs.query({ windowId })
  const groupTabCounts = new Map<number, number>()
  for (const group of groups) {
    const count = tabs.filter((t) => t.groupId === group.id).length
    groupTabCounts.set(group.id, count)
  }

  const sortedGroups = [...groups].sort((a, b) => {
    const countA = groupTabCounts.get(a.id) ?? 0
    const countB = groupTabCounts.get(b.id) ?? 0
    if (countB !== countA) {
      return countB - countA
    }
    const nameA = (a.title || groupTitleMap.get(a.id) || '').trim()
    const nameB = (b.title || groupTitleMap.get(b.id) || '').trim()
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true })
  })

  const pinnedCount = tabs.filter((t) => t.pinned).length
  let currentIndex = pinnedCount

  for (const group of sortedGroups) {
    const memberTabs = tabs.filter((t) => t.groupId === group.id)
    const tabIds = memberTabs.map((t) => t.id).filter((id): id is number => id !== undefined)
    if (tabIds.length > 0) {
      await retryTabOperation(() => chrome.tabs.move(tabIds, { index: currentIndex }))
      currentIndex += tabIds.length
    }
  }

  invalidatePreviewCache(windowId)
}


export async function mergeAllWindows(targetWindowId: number): Promise<void> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  for (const win of windows) {
    if (win.id === undefined || win.id === targetWindowId) continue
    const tabs = await chrome.tabs.query({ windowId: win.id })
    const tabIds = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
    if (tabIds.length > 0) {
      await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 })
    }
  }
  invalidatePreviewCache()
}

export async function muteAllTabs(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      await chrome.tabs.update(tab.id, { muted: true })
    }
  }
}

export async function unmuteAllTabs(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })
  for (const tab of tabs) {
    if (tab.id !== undefined) {
      await chrome.tabs.update(tab.id, { muted: false })
    }
  }
}

export async function closeLeftTabs(windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId })
  if (!activeTab || activeTab.index === undefined) return
  const tabs = await chrome.tabs.query({ windowId })
  const toClose = tabs
    .filter((t) => t.index !== undefined && t.index < activeTab.index && t.id !== undefined && !t.pinned)
    .map((t) => t.id!)
  if (toClose.length > 0) {
    await chrome.tabs.remove(toClose)
    for (const id of toClose) cacheRemoveTab(id)
  }
}

export async function closeRightTabs(windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId })
  if (!activeTab || activeTab.index === undefined) return
  const tabs = await chrome.tabs.query({ windowId })
  const toClose = tabs
    .filter((t) => t.index !== undefined && t.index > activeTab.index && t.id !== undefined && !t.pinned)
    .map((t) => t.id!)
  if (toClose.length > 0) {
    await chrome.tabs.remove(toClose)
    for (const id of toClose) cacheRemoveTab(id)
  }
}

/**
 * Ungroup tab groups that have less than a specified number of tabs.
 */
export async function cleanupTabGroups(windowId: number, minTabs: number): Promise<void> {
  // Logic: Abort if tab groups are not supported in the browser
  // Programming logic: Return early if tab groups are not supported in this browser
  if (!isTabGroupsSupported()) return
  const tabs = await chrome.tabs.query({ windowId })

  // Programming logic: Count tabs per group ID
  const groupCounts = new Map<number, number>()
  const groupTabs = new Map<number, number[]>()

  for (const tab of tabs) {
    if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE && tab.id !== undefined) {
      const currentCount = groupCounts.get(tab.groupId) ?? 0
      groupCounts.set(tab.groupId, currentCount + 1)

      const tabIds = groupTabs.get(tab.groupId) ?? []
      tabIds.push(tab.id)
      groupTabs.set(tab.groupId, tabIds)
    }
  }

  // Logic: Iterate through all tab groups and dissolve (close) those that contain fewer than minTabs tabs
  // Programming logic: Loop through groups and remove tabs for groups with fewer tabs than minTabs
  for (const [groupId, count] of groupCounts.entries()) {
    if (count < minTabs) {
      const tabIds = groupTabs.get(groupId)
      if (tabIds && tabIds.length > 0) {
        await retryTabOperation(() => chrome.tabs.remove(tabIds))
      }
    }
  }
}
