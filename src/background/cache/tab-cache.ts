'use strict';

import { classify, classifyTabs, groupTabsFreelyWithAI } from '../classifier'
import type { FreeGroupResult } from '../classifier'
import {
  isTabGroupsSupported,
  TAB_GROUP_ID_NONE,
  groupTitleMap,
  titlesHiddenMap,
  getSettings,
  sortTabsByDomainAndTitleHelper,
} from '../tabs/tab-common'
import {
  activeOperationsMap,
  clearActiveOperation,
  activeAbortControllers,
  lastAutoExtendMap,
  clearOperationTimeout,
} from '../operations/operation-registry'
import {
  setAIBadge,
  updateNewTabsBadge,
  badgeTimeoutsByWindow,
} from '../operations/badge-service'
import type {
  GroupCategory,
  GroupedTabs,
  TabInfo,
  ChromeTabGroupColor,
} from '../../shared/types'

const CACHE_DEBOUNCE_MS = 300

export const tabCreatedTimesMap = new Map<number, number>()
export const previewCacheMap = new Map<number, GroupedTabs[]>()
export const cacheIsAIGroupedMap = new Map<number, boolean>()
export const rebuildTimeoutsByWindow = new Map<number, ReturnType<typeof setTimeout>>()

export function recordTabCreatedTime(tabId: number, time = Date.now()): void {
  if (!tabCreatedTimesMap.has(tabId)) {
    tabCreatedTimesMap.set(tabId, time)
  }
}

export function removeTabCreatedTime(tabId: number): void {
  tabCreatedTimesMap.delete(tabId)
}

export function chromeTabToTabInfo(tab: chrome.tabs.Tab): TabInfo | null {
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
    audible: tab.audible,
    lastAccessed: tab.lastAccessed,
    createdAt: tabCreatedTimesMap.get(tab.id) ?? tab.lastAccessed,
  }
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

  const unpinnedTabs = chromeTabs.filter((t) => !t.pinned)
  const result: GroupedTabs[] = freeGroups
    .map((g) => ({
      category: 'other' as GroupCategory,
      tabs: tabsFromChrome(unpinnedTabs, g.tabIds, tabMap),
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

  const unpinnedTabs = chromeTabs.filter((t) => !t.pinned)
  for (const [category, tabIds] of groups) {
    const categoryTabs = tabsFromChrome(unpinnedTabs, tabIds, tabMap)
    if (categoryTabs.length > 0) {
      result.push({ category, tabs: categoryTabs })
    }
  }

  return result
}

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

  if (tab.id !== undefined) {
    cacheRemoveTab(tab.id)
  }

  const tabInfo = chromeTabToTabInfo(tab)
  if (!tabInfo) return

  if (tab.pinned) {
    const pinnedGroup = previewCache.find((g) => g.isPinnedGroup || g.groupName === 'Pinned')
    if (pinnedGroup) {
      pinnedGroup.tabs.push(tabInfo)
    } else {
      previewCache.unshift({
        category: 'other',
        groupName: 'Pinned',
        isPinnedGroup: true,
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
    const tabInfo = chromeTabToTabInfo(tab)
    if (!tabInfo) return

    for (const group of previewCache) {
      const idx = group.tabs.findIndex((t) => t.id === tab.id)
      if (idx !== -1) {
        group.tabs[idx] = tabInfo
        return
      }
    }
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

export function clearWindowCache(windowId: number): void {
  previewCacheMap.delete(windowId)
  cacheIsAIGroupedMap.delete(windowId)
  titlesHiddenMap.delete(windowId)
  clearActiveOperation(windowId)
  lastAutoExtendMap.delete(windowId)
  clearOperationTimeout(windowId)
  const bt = badgeTimeoutsByWindow.get(windowId)
  if (bt) {
    clearTimeout(bt)
    badgeTimeoutsByWindow.delete(windowId)
  }
  const rt = rebuildTimeoutsByWindow.get(windowId)
  if (rt) {
    clearTimeout(rt)
    rebuildTimeoutsByWindow.delete(windowId)
  }
  const controller = activeAbortControllers.get(windowId)
  if (controller) {
    controller.abort()
    activeAbortControllers.delete(windowId)
  }
  updateNewTabsBadge().catch(console.error)
}

async function rebuildCache(windowId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId })
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
        },
      ])
    } else {
      const unpinnedTabs = tabs.filter((t) => !t.pinned)
      previewCacheMap.set(windowId, sortGroups(ruleGroupsToGroupedTabs(classifyTabs(unpinnedTabs), tabs)))
    }
    cacheIsAIGroupedMap.set(windowId, false)
  }
}

export function debouncedCacheRebuild(windowId: number): void {
  const op = activeOperationsMap.get(windowId)
  if (op && op.type) {
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

async function buildGroupsFromChrome(tabs: chrome.tabs.Tab[]): Promise<GroupedTabs[] | null> {
  if (!isTabGroupsSupported()) return null
  const groupedTabs = tabs.filter((t) => t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE)
  if (groupedTabs.length === 0) return null

  const groupIds = [...new Set(groupedTabs.map((t) => t.groupId))]
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
      // Fallback below
    }
  }

  if (chromeGroups.size === 0) {
    await Promise.all(
      groupIds.map(async (gid) => {
        try {
          const group = await chrome.tabGroups.get(gid)
          chromeGroups.set(gid, group)
        } catch {
          // Group removed
        }
      }),
    )
  }

  if (chromeGroups.size === 0) return null

  const result: GroupedTabs[] = []

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

  for (const [gid, chromeGroup] of chromeGroups) {
    const memberTabs = tabs.filter((t) => !t.pinned && t.groupId === gid)
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
      await setAIBadge(windowId)
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
        console.error('[timTabTool] AI free grouping failed in preview, falling back to rule engine. Error:', err)
        const unpinnedTabs = tabs.filter((t) => !t.pinned)
        result = ruleGroupsToGroupedTabs(classifyTabs(unpinnedTabs), tabs)
      }
      cacheIsAIGroupedMap.set(windowId, false)
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
        const unpinnedTabs = tabs.filter((t) => !t.pinned)
        result = ruleGroupsToGroupedTabs(classifyTabs(unpinnedTabs), tabs)
      }
      cacheIsAIGroupedMap.set(windowId, false)
    }
  }

  const sorted = sortGroups(result)
  previewCacheMap.set(windowId, sorted)
  return sorted
}
