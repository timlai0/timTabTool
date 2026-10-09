'use strict';

import {
  isTabGroupsSupported,
  TAB_GROUP_ID_NONE,
  groupTitleMap,
  updatingGroups,
  titlesHiddenMap,
  getSettings,
  retryTabOperation,
  sortTabsByDomainAndTitleHelper,
} from './tab-common'
import { markTabIdsClosedByExtension } from './live-tab-tracker'
import { recordClosedTabs, recordTabIdsBeforeClose } from '../../shared/closed-tabs-manager'
import { detectDuplicateTabs } from '../../shared/duplicate-detector'
import { extractDomain } from '../../shared/utils'
import { invalidatePreviewCache, cacheRemoveTab } from '../cache/tab-cache'
import { updateNewTabsBadge, debouncedUpdateNewTabsBadge } from '../operations/badge-service'
import { setActiveOperation } from '../operations/operation-registry'
import type { ChromeTabGroupColor } from '../../shared/types'

export async function closeGroupTabs(tabIds: number[]): Promise<void> {
  if (tabIds.length === 0) return
  markTabIdsClosedByExtension(tabIds)
  await recordTabIdsBeforeClose(tabIds, 'Group')
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

async function setAllGroupsCollapsed(windowId: number, collapsed: boolean): Promise<void> {
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

export async function toggleGroupTitles(windowId: number): Promise<boolean> {
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
          // Group removed
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

export async function ungroupAllTabs(windowId: number): Promise<void> {
  if (!isTabGroupsSupported()) return
  const tabs = await chrome.tabs.query({ windowId })
  const tabIds = tabs
    .filter((t) => t.groupId !== TAB_GROUP_ID_NONE && t.id !== undefined)
    .map((t) => t.id!)

  if (tabIds.length > 0) {
    await retryTabOperation(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]))
  }
  await updateNewTabsBadge(windowId).catch(console.error)
}

export async function ungroupGroupTabs(tabIds: number[]): Promise<void> {
  if (!isTabGroupsSupported() || tabIds.length === 0) return
  await retryTabOperation(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]))
  invalidatePreviewCache()
}

export async function handleTabGroupUpdated(group: chrome.tabGroups.TabGroup): Promise<void> {
  if (!isTabGroupsSupported()) return
  if (updatingGroups.has(group.id)) return

  const hidden = titlesHiddenMap.get(group.windowId) ?? false
  if (hidden) {
    if (group.title !== '') {
      updatingGroups.add(group.id)
      try {
        await chrome.tabGroups.update(group.id, { title: '' })
      } catch {
        // Group removed
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
    // Group removed
  } finally {
    updatingGroups.delete(group.id)
  }
}

export function handleTabGroupRemoved(groupId: number): void {
  groupTitleMap.delete(groupId)
  updatingGroups.delete(groupId)
}

export async function closeDuplicateTabs(windowId?: number, explicitTabIds?: number[]): Promise<void> {
  if (Array.isArray(explicitTabIds) && explicitTabIds.length > 0) {
    markTabIdsClosedByExtension(explicitTabIds)
    await recordTabIdsBeforeClose(explicitTabIds, 'Duplicates')
    await chrome.tabs.remove(explicitTabIds)
    for (const id of explicitTabIds) cacheRemoveTab(id)
    return
  }
  const queryInfo: chrome.tabs.QueryInfo = (windowId !== undefined && windowId > 0 && windowId !== chrome.windows.WINDOW_ID_NONE) ? { windowId } : {}
  const tabs = await chrome.tabs.query(queryInfo)
  const result = detectDuplicateTabs(tabs)
  const dupIds = result.exactDuplicates.map(t => t.id).filter((id): id is number => id !== undefined)

  if (dupIds.length > 0) {
    markTabIdsClosedByExtension(dupIds)
    await recordClosedTabs(result.exactDuplicates, 'Duplicates')
    await chrome.tabs.remove(dupIds)
    for (const id of dupIds) cacheRemoveTab(id)
  }
}

export async function closePossibleDuplicateTabs(windowId?: number, explicitTabIds?: number[]): Promise<void> {
  if (Array.isArray(explicitTabIds) && explicitTabIds.length > 0) {
    markTabIdsClosedByExtension(explicitTabIds)
    await recordTabIdsBeforeClose(explicitTabIds, 'Possible Duplicates')
    await chrome.tabs.remove(explicitTabIds)
    for (const id of explicitTabIds) cacheRemoveTab(id)
    return
  }
  const queryInfo: chrome.tabs.QueryInfo = (windowId !== undefined && windowId > 0 && windowId !== chrome.windows.WINDOW_ID_NONE) ? { windowId } : {}
  const tabs = await chrome.tabs.query(queryInfo)
  const result = detectDuplicateTabs(tabs)
  const dupIds: number[] = []
  const tabsToClose: Array<{ id?: number; url?: string; title?: string; favIconUrl?: string; windowId?: number }> = []

  let cluster: (typeof result.possibleDuplicates)[0]
  let keepId: number | undefined
  let tab: (typeof cluster.tabs)[0]

  for (cluster of result.possibleDuplicates) {
    keepId = cluster.primaryTabId ?? cluster.tabs.find(t => (t as any).active)?.id ?? cluster.tabs[0]?.id

    for (tab of cluster.tabs) {
      if (tab.id !== undefined && tab.id !== keepId) {
        dupIds.push(tab.id)
        tabsToClose.push(tab)
      }
    }
  }

  if (dupIds.length > 0) {
    markTabIdsClosedByExtension(dupIds)
    await recordClosedTabs(tabsToClose, 'Possible Duplicates')
    await chrome.tabs.remove(dupIds)
    for (const id of dupIds) cacheRemoveTab(id)
  }
}

export async function organizePossibleDuplicateGroups(targetWindowId?: number): Promise<void> {
  const queryFilter: chrome.tabs.QueryInfo = (targetWindowId !== undefined && targetWindowId > 0 && targetWindowId !== chrome.windows.WINDOW_ID_NONE) ? { windowId: targetWindowId } : {}
  const tabs = await chrome.tabs.query(queryFilter)
  const result = detectDuplicateTabs(tabs)

  if (result.possibleDuplicates.length === 0) return

  const colors: ChromeTabGroupColor[] = ['orange', 'yellow', 'pink', 'purple', 'cyan', 'blue']
  let colorIdx = 0

  const usedTitles = new Set<string>()
  if (isTabGroupsSupported()) {
    const existingTabGroups = await chrome.tabGroups.query({}).catch(() => [])
    for (const eg of existingTabGroups) {
      if (eg.title) usedTitles.add(eg.title.toLowerCase().trim())
    }
  }

  for (const cluster of result.possibleDuplicates) {
    const tabIds = cluster.tabs.map(t => t.id).filter((id): id is number => id !== undefined)
    if (tabIds.length < 2) continue

    if (isTabGroupsSupported()) {
      try {
        const clusterTabs = await chrome.tabs.query({})
        const targetTab = clusterTabs.find(t => t.id === tabIds[0])
        if (targetTab && targetTab.windowId) {
          for (const tid of tabIds.slice(1)) {
            const t = clusterTabs.find(x => x.id === tid)
            if (t && t.windowId !== targetTab.windowId) {
              await chrome.tabs.move(tid, { windowId: targetTab.windowId, index: -1 })
            }
          }
        }
        const groupId = (await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] })) as unknown as number
        
        const titleSnippet = cluster.title ? cluster.title.trim().slice(0, 24) : ''
        const baseTitle = titleSnippet ? `Dupes: ${titleSnippet}` : `Dupes: ${cluster.domain || 'Cluster'}`
        let groupTitle = baseTitle
        let counter = 2
        while (usedTitles.has(groupTitle.toLowerCase())) {
          groupTitle = `${baseTitle} (${counter++})`
        }
        usedTitles.add(groupTitle.toLowerCase())

        const groupColor = colors[colorIdx % colors.length]
        colorIdx++

        await chrome.tabGroups.update(groupId, {
          title: groupTitle,
          color: groupColor,
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
  const tabsToClose: chrome.tabs.Tab[] = []
  const toClose: number[] = []
  for (const tab of tabs) {
    if (tab.id === undefined || !tab.url) continue
    if (extractDomain(tab.url) === activeDomain) {
      toClose.push(tab.id)
      tabsToClose.push(tab)
    }
  }
  if (toClose.length > 0) {
    markTabIdsClosedByExtension(toClose)
    await recordClosedTabs(tabsToClose, 'Domain')
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
  setActiveOperation(windowId, 'sort')
  try {
    const tabs = await chrome.tabs.query({ windowId })

    const ungrouped = tabs.filter((t) => !t.pinned && (t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE))
    if (ungrouped.length > 0) {
      const sorted = sortTabsByDomainAndTitleHelper(ungrouped)
      const tabIds = sorted.map((t) => t.id).filter((id): id is number => id !== undefined)
      const originalIds = ungrouped.map((t) => t.id).filter((id): id is number => id !== undefined)
      const isAlreadySorted = originalIds.length === tabIds.length && originalIds.every((id, i) => id === tabIds[i])
      if (!isAlreadySorted) {
        await retryTabOperation(() => chrome.tabs.move(tabIds, { index: -1 }))
      }
    }

    const groupIds = [...new Set(tabs.map(t => t.groupId).filter(id => id !== undefined && id !== TAB_GROUP_ID_NONE))]
    for (const gid of groupIds) {
      const groupTabs = tabs.filter(t => t.groupId === gid)
      if (groupTabs.length > 0) {
        const sorted = sortTabsByDomainAndTitleHelper(groupTabs)
        const tabIds = sorted.map((t) => t.id).filter((id): id is number => id !== undefined)
        const originalIds = groupTabs.map((t) => t.id).filter((id): id is number => id !== undefined)
        const isAlreadySorted = originalIds.length === tabIds.length && originalIds.every((id, i) => id === tabIds[i])
        if (!isAlreadySorted) {
          const startIndex = Math.min(...groupTabs.map(t => t.index))
          await retryTabOperation(() => chrome.tabs.move(tabIds, { index: startIndex }))
        }
      }
    }

    invalidatePreviewCache(windowId)
    debouncedUpdateNewTabsBadge(windowId)
  } finally {
    setActiveOperation(windowId, null)
  }
}

export async function sortGroupsByName(windowId: number): Promise<void> {
  if (!isTabGroupsSupported()) return
  setActiveOperation(windowId, 'sort')
  try {
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
  } finally {
    setActiveOperation(windowId, null)
  }
}

export async function sortGroupsBySize(windowId: number): Promise<void> {
  if (!isTabGroupsSupported()) return
  setActiveOperation(windowId, 'sort')
  try {
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
  } finally {
    setActiveOperation(windowId, null)
  }
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
  const tabsToClose = tabs.filter((t) => t.index !== undefined && t.index < activeTab.index && t.id !== undefined && !t.pinned)
  if (tabsToClose.length > 0) {
    const toClose = tabsToClose.map((t) => t.id!)
    markTabIdsClosedByExtension(toClose)
    await recordClosedTabs(tabsToClose, 'Tabs to Left')
    await chrome.tabs.remove(toClose)
    for (const id of toClose) cacheRemoveTab(id)
  }
}

export async function closeRightTabs(windowId: number): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, windowId })
  if (!activeTab || activeTab.index === undefined) return
  const tabs = await chrome.tabs.query({ windowId })
  const tabsToClose = tabs.filter((t) => t.index !== undefined && t.index > activeTab.index && t.id !== undefined && !t.pinned)
  if (tabsToClose.length > 0) {
    const toClose = tabsToClose.map((t) => t.id!)
    markTabIdsClosedByExtension(toClose)
    await recordClosedTabs(tabsToClose, 'Tabs to Right')
    await chrome.tabs.remove(toClose)
    for (const id of toClose) cacheRemoveTab(id)
  }
}

export async function cleanupTabGroups(windowId: number, minTabs: number): Promise<void> {
  if (!isTabGroupsSupported()) return
  const tabs = await chrome.tabs.query({ windowId })

  const groupCounts = new Map<number, number>()
  const groupTabs = new Map<number, number[]>()

  for (const tab of tabs) {
    if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE && tab.id !== undefined) {
      const currentCount = groupCounts.get(tab.groupId) ?? 0
      groupCounts.set(tab.groupId, currentCount + 1)

      const currentList = groupTabs.get(tab.groupId) ?? []
      currentList.push(tab.id)
      groupTabs.set(tab.groupId, currentList)
    }
  }

  for (const [groupId, count] of groupCounts.entries()) {
    if (count < minTabs) {
      const ids = groupTabs.get(groupId) ?? []
      if (ids.length > 0) {
        await retryTabOperation(() => chrome.tabs.ungroup(ids as [number, ...number[]]))
      }
    }
  }
}
