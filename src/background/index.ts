'use strict';

import '../shared/polyfill'

import {
  groupAllTabs,
  ungroupAllTabs,
  ungroupGroupTabs,
  closeGroupTabs,
  classifyNewTabs,
  autoGroupNewTab,
  expandAllGroups,
  collapseAllGroups,
  toggleGroupTitles,
  areGroupTitlesHidden,
  getGroupsPreview,
  invalidatePreviewCache,
  cacheAddTab,
  cacheRemoveTab,
  cacheUpdateTab,
  debouncedCacheRebuild,
  handleTabGroupUpdated,
  handleTabGroupRemoved,
  cancelActiveOperation,
  getActiveOperations,
  setActiveOperation,
  clearOperationError,
  clearWindowCache,
  cleanupTabGroups,
  splitGroup,
  mergeGroup,
  closeDuplicateTabs,
  closePossibleDuplicateTabs,
  organizePossibleDuplicateGroups,
  closeDomainTabs,
  isolateDomainTabs,
  sortTabsByDomainAndTitle,
  sortGroupsByName,
  sortGroupsBySize,
  mergeAllWindows,
  muteAllTabs,
  unmuteAllTabs,
  closeLeftTabs,
  closeRightTabs,
  isRestrictedUrl,
  recordTabCreatedTime,
  removeTabCreatedTime,
} from './tab-manager'
import { searchTabs } from './searcher'
import { recordTabVisit, getHistoryEntries } from './storage'
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants'
import type { ExtensionMessage, TabInfo, ExtensionSettings, WindowGroupsInfo } from '../shared/types'
import { initMCPBridge, getMCPStatus, reconnectMCP } from './mcp-bridge'

const TAB_GROUP_ID_NONE = typeof chrome !== 'undefined' && typeof chrome.tabGroups !== 'undefined'
  ? chrome.tabGroups.TAB_GROUP_ID_NONE
  : -1

console.log('[timTabTool] Service worker started')

chrome.storage.local.get(STORAGE_KEYS.SETTINGS).then((data) => {
  const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
  chrome.action.setPopup({ popup: saved.useSearchPopup ? 'src/popup/search.html' : 'src/popup/index.html' })
}).catch(console.error)

chrome.runtime.onInstalled.addListener(() => {
  console.log('[timTabTool] Extension installed')
  // Programming logic: Create context menu items to open search (in-page and window)
  chrome.contextMenus.create({
    id: 'open-search-menu',
    title: chrome.i18n.getMessage('contextMenuOpenSearch') || 'Open Search',
    contexts: ['action', 'page']
  })
  chrome.contextMenus.create({
    id: 'open-search-window',
    title: chrome.i18n.getMessage('contextMenuOpenSearchWindow') || 'Open Search in New Window',
    contexts: ['action', 'page']
  })
  chrome.contextMenus.create({
    id: 'open-search-tab',
    title: chrome.i18n.getMessage('contextMenuOpenSearchTab') || 'Open Search in New Tab',
    contexts: ['action']
  })
  chrome.contextMenus.create({
    id: 'separator-1',
    type: 'separator',
    contexts: ['action']
  })
  chrome.contextMenus.create({
    id: 'group-all',
    title: chrome.i18n.getMessage('contextMenuGroupAll') || 'Group Tabs (AI)',
    contexts: ['action']
  })
  chrome.contextMenus.create({
    id: 'cleanup-groups',
    title: chrome.i18n.getMessage('contextMenuCleanupGroups') || 'Clean Up Tab Groups',
    contexts: ['action']
  })
  chrome.contextMenus.create({
    id: 'ungroup-all',
    title: chrome.i18n.getMessage('contextMenuUngroupAll') || 'Ungroup All Tabs',
    contexts: ['action']
  })

  const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')
  if (isFirefox) {
    chrome.contextMenus.create({
      id: 'move-to-other-window',
      title: chrome.i18n.getMessage('contextMenuMoveToOtherWindow') || 'Move Tab to Other Window',
      contexts: ['action']
    })
  }
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-search-menu') {
    await toggleSearchOverlay()
  } else if (info.menuItemId === 'open-search-window') {
    if (!(await focusExistingSearchTabOrWindow())) {
      await openSearchInNewWindow()
    }
  } else if (info.menuItemId === 'open-search-tab') {
    if (!(await focusExistingSearchTabOrWindow())) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/search.html'), pinned: true })
    }
  } else if (info.menuItemId === 'ungroup-all') {
    const windowId = tab?.windowId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId
    if (windowId !== undefined) await ungroupAllTabs(windowId)
  } else if (info.menuItemId === 'group-all') {
    const windowId = tab?.windowId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId
    if (windowId !== undefined) await groupAllTabs(windowId)
  } else if (info.menuItemId === 'cleanup-groups') {
    const windowId = tab?.windowId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId
    if (windowId !== undefined) await cleanupTabGroups(windowId, 3)
  } else if (info.menuItemId === 'move-to-other-window' && tab?.id) {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
    const otherWindows = windows.filter(w => w.id !== undefined && w.id !== tab.windowId)
    if (otherWindows.length > 0) {
      await chrome.tabs.move(tab.id, { windowId: otherWindows[0].id!, index: -1 })
      await chrome.windows.update(otherWindows[0].id!, { focused: true })
      await chrome.tabs.update(tab.id, { active: true })
    } else {
      await chrome.windows.create({ tabId: tab.id, type: 'normal', focused: true })
    }
  }
})

// --- Tab history tracking + cache updates ---
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) recordTabCreatedTime(tab.id)
  cacheAddTab(tab)
  if (tab.windowId !== undefined) debouncedCacheRebuild(tab.windowId)
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.title) {
    recordTabVisit(tab.url, tab.title, tab.favIconUrl)
    cacheUpdateTab(tab)
    autoGroupNewTab(tab).catch((err) =>
      console.error('[timTabTool] autoGroupNewTab failed:', err),
    )
  } else if (changeInfo.url) {
    cacheUpdateTab(tab)
  }
  if (tab.windowId !== undefined) debouncedCacheRebuild(tab.windowId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabCreatedTime(tabId)
  cacheRemoveTab(tabId)
})

chrome.windows.onRemoved.addListener(async (windowId) => {
  clearWindowCache(windowId)
  const data = await chrome.storage.local.get('customWindowNames')
  if (data.customWindowNames && (data.customWindowNames as Record<number, string>)[windowId]) {
    const newNames = { ...(data.customWindowNames as Record<number, string>) }
    delete newNames[windowId]
    await chrome.storage.local.set({ customWindowNames: newNames })
  }
})

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    if (tab.url && tab.title) {
      recordTabVisit(tab.url, tab.title, tab.favIconUrl)
    }
  } catch {
    // Tab may have been removed
  }
})

// --- Smart group title: toggle title on collapse/expand + cache rebuild ---
// Logic: Register tab group listeners only if the API is available in the browser (not in Firefox)
// Programming logic: only register tab group listeners if tabGroups API is available
if (typeof chrome.tabGroups !== 'undefined') {
  chrome.tabGroups.onCreated.addListener((group) => {
    debouncedCacheRebuild(group.windowId)
  })

  chrome.tabGroups.onUpdated.addListener((group) => {
    handleTabGroupUpdated(group)
    debouncedCacheRebuild(group.windowId)
  })

  chrome.tabGroups.onRemoved.addListener((group) => {
    handleTabGroupRemoved(group.id)
    debouncedCacheRebuild(group.windowId)
  })
}

// --- Command handler (keyboard shortcut) ---
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-search') {
    await toggleSearchOverlay()
  } else if (command === 'open-search-slash') {
    await toggleSearchOverlay('/')
  }
})

async function ensureContentScriptLoaded(tabId: number): Promise<boolean> {
  try {
    const [checkResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(window as unknown as Record<string, boolean>).__ATM_SEARCH_LOADED__,
    })
    if (checkResult?.result) return true
  } catch {
    // scripting.executeScript failed — tab may not support it
    return false
  }

  // Inject content script if not loaded
  try {
    const manifest = chrome.runtime.getManifest()
    const contentScriptFiles = manifest.content_scripts?.[0]?.js || []
    if (contentScriptFiles.length > 0) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: contentScriptFiles,
      })
      return true
    }
  } catch {
    // Content script file missing or failed to load (e.g. extension recompiled)
    return false
  }
  return false
}

async function broadcastAIStart(windowId: number, action: string) {
  try {
    // Clear stale AI results from storage and notify UI
    await chrome.storage.local.remove(STORAGE_KEYS.LAST_AI_RESULT)
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: null }).catch(() => {})

    // Broadcast to internal extension views (e.g. search.html)
    chrome.runtime.sendMessage({
      action: 'START_AI_PROGRESS',
      payload: { commandAction: action }
    }).catch(() => {})

    const tabs = await chrome.tabs.query({ active: true, windowId })
    let targetTab: chrome.tabs.Tab | undefined = tabs[0]
    if (!targetTab || !targetTab.url || isRestrictedUrl(targetTab.url)) {
      const winTabs = await chrome.tabs.query({ windowId })
      targetTab = winTabs.find(t => t.id && t.url && !isRestrictedUrl(t.url))
    }

    if (targetTab?.id && targetTab.url) {
      const loaded = await ensureContentScriptLoaded(targetTab.id)
      if (!loaded) return

      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'START_AI_PROGRESS',
        payload: { commandAction: action }
      }).catch(() => {})
    }
  } catch {
    // Non-critical progress broadcast error
  }
}

async function broadcastAIComplete(windowId: number, action: string) {
  try {
    // Broadcast to internal extension views
    chrome.runtime.sendMessage({
      action: 'AI_OPERATION_COMPLETE',
      payload: { commandAction: action }
    }).catch(() => {})

    const tabs = await chrome.tabs.query({ active: true, windowId })
    let targetTab: chrome.tabs.Tab | undefined = tabs[0]
    if (!targetTab || !targetTab.url || isRestrictedUrl(targetTab.url)) {
      const winTabs = await chrome.tabs.query({ windowId })
      targetTab = winTabs.find(t => t.id && t.url && !isRestrictedUrl(t.url))
    }

    if (targetTab?.id && targetTab.url) {
      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'AI_OPERATION_COMPLETE',
        payload: { commandAction: action }
      }).catch(() => {})
    }
  } catch {
    // Non-critical progress broadcast error
  }
}

async function broadcastAIFailed(windowId: number, action: string, errorMsg: string) {
  try {
    const lastResult = {
      timestamp: Date.now(),
      actionType: action.toLowerCase(),
      actionTitle: action,
      windowId: windowId,
      tabsProcessed: 0,
      summary: 'AI Operation Failed',
      error: errorMsg
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})

    // Broadcast to internal extension views
    chrome.runtime.sendMessage({
      action: 'AI_OPERATION_FAILED',
      payload: { commandAction: action, error: errorMsg }
    }).catch(() => {})

    const tabs = await chrome.tabs.query({ active: true, windowId })
    let targetTab: chrome.tabs.Tab | undefined = tabs[0]
    if (!targetTab || !targetTab.url || isRestrictedUrl(targetTab.url)) {
      const winTabs = await chrome.tabs.query({ windowId })
      targetTab = winTabs.find(t => t.id && t.url && !isRestrictedUrl(t.url))
    }

    if (targetTab?.id && targetTab.url) {
      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'AI_OPERATION_FAILED',
        payload: { commandAction: action, error: errorMsg }
      }).catch(() => {})
    }
  } catch {
    // Non-critical progress broadcast error
  }
}

async function toggleSearchOverlay(initialQuery = '') {
  try {
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tabs || tabs.length === 0) {
      tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    }
    const tab = tabs[0]
    if (!tab?.id || !tab.url) return
    // Skip restricted URLs where content scripts can't run
    if (isRestrictedUrl(tab.url)) return

    const tabId = tab.id
    await ensureContentScriptLoaded(tabId)

    // Toggle the overlay via executeScript with polling for Vite's async chunk loading
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (query) => {
        let attempts = 0
        const tryToggle = () => {
          const toggleFn = (window as unknown as Record<string, (q?: string) => void>).__ATM_TOGGLE_SEARCH__
          if (toggleFn) {
            toggleFn(query)
          } else if (attempts < 60) {
            attempts++
            setTimeout(tryToggle, 50)
          }
        }
        tryToggle()
      },
      args: [initialQuery],
    })
  } catch {
    // Tab doesn't support scripting (e.g. chrome:// pages)
  }
}

async function focusExistingSearchTabOrWindow(): Promise<boolean> {
  try {
    const searchUrl = chrome.runtime.getURL('src/popup/search.html')
    const existingTabs = await chrome.tabs.query({ url: searchUrl })
    if (existingTabs.length > 0) {
      const tab = existingTabs[0]
      if (tab.id && tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true })
        await chrome.tabs.update(tab.id, { active: true })
        return true
      }
    }
  } catch (err) {
    console.error('[timTabTool] Failed to focus existing search tab:', err)
  }
  return false
}

async function openSearchInNewWindow() {
  try {
    // Programming logic: Get the current window to position the search popup centered over it
    const currentWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    const flyoutWidth = 380
    const searchMenuWidth = 680
    const totalWidth = flyoutWidth + searchMenuWidth
    const searchHeight = 550

    const mainLeft = currentWin.left ?? 0
    const mainTop = currentWin.top ?? 0
    const mainWidth = currentWin.width ?? 1024
    const mainHeight = currentWin.height ?? 768

    // Logic: Place the new standalone search window centered over the current browser window
    // Programming logic: Position the new standalone search window centered over the current browser window
    const searchLeft = Math.max(0, mainLeft + Math.round((mainWidth - totalWidth) / 2))
    const searchTop = Math.max(0, mainTop + Math.round((mainHeight - searchHeight) / 2))

    // Programming logic: Create new popup-type window containing both flyout and search side-by-side
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/popup/search.html'),
      type: 'popup',
      width: totalWidth,
      height: searchHeight,
      left: searchLeft,
      top: searchTop,
      focused: true
    })
  } catch (err) {
    console.error('[timTabTool] Failed to open search in new window:', err)
  }
}

// --- Message handler ---
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch((err) => {
      console.error(`[timTabTool] Error handling action "${message.action}" with payload:`, message.payload, 'Error:', err)
      sendResponse({ error: err.message })
    })
    return true
  },
)

/** Resolve window ID from message payload or last focused window (for popup context). */
async function resolveWindowId(payload: unknown): Promise<number> {
  const windowId = (payload as { windowId?: number })?.windowId
  if (windowId !== undefined && Number.isInteger(windowId)) return windowId
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
  return win?.id ?? chrome.windows.WINDOW_ID_NONE
}

export function getAIOverrides(payload: unknown): Partial<ExtensionSettings['ai']> | undefined {
  if (payload && typeof payload === 'object') {
    const p = payload as { provider?: unknown; model?: unknown; sendFullUrl?: unknown; sendRandomOrder?: unknown; groupingPrompt?: unknown; customPrompt?: unknown }
    const overrides: Partial<ExtensionSettings['ai']> = {}
    
    if (typeof p.model === 'string' && p.model !== '-full') {
      overrides.model = p.model
    }
    
    if (typeof p.provider === 'string') {
      const providerStr = p.provider
      if (providerStr === "openai" || providerStr === "claude" || providerStr === "gemini" || providerStr === "custom") {
        overrides.provider = providerStr
      }
    }
    
    if (typeof p.sendFullUrl === 'boolean') {
      overrides.sendFullUrl = p.sendFullUrl
    }
    
    if (typeof p.sendRandomOrder === 'boolean') {
      overrides.sendRandomOrder = p.sendRandomOrder
    }
    
    if (typeof p.groupingPrompt === 'string' && p.groupingPrompt.trim()) {
      overrides.groupingPrompt = p.groupingPrompt.trim()
    } else if (typeof p.customPrompt === 'string' && p.customPrompt.trim()) {
      overrides.groupingPrompt = p.customPrompt.trim()
    }

    if (typeof (p as any).bypassSafeguards === 'boolean') {
      overrides.bypassSafeguards = (p as any).bypassSafeguards
    }
    
    if (Object.keys(overrides).length > 0) {
      return overrides
    }
  }
  return undefined
}

async function handleMessage(message: ExtensionMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.action) {
    case 'GROUP_TABS': {
      const windowId = await resolveWindowId(message.payload)
      setActiveOperation(windowId, 'group')
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        const overrides = getAIOverrides(message.payload)
        await groupAllTabs(windowId, overrides)
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'UNGROUP_ALL': {
      const windowId = await resolveWindowId(message.payload)
      await ungroupAllTabs(windowId)
      invalidatePreviewCache(windowId)
      return { ok: true }
    }

    case 'CLEANUP_GROUPS': {
      // Programming logic: Resolve windowId and minTabs parameter from payload
      const windowId = await resolveWindowId(message.payload)
      const minTabs = (message.payload as { minTabs?: number })?.minTabs ?? 3
      // Logic: Dissolve tab groups with fewer than minTabs tabs in the specified window
      await cleanupTabGroups(windowId, minTabs)
      invalidatePreviewCache(windowId)
      return { ok: true }
    }

    case 'CLOSE_GROUP': {
      const tabIds = (message.payload as { tabIds: number[] })?.tabIds || []
      await closeGroupTabs(tabIds)
      return { ok: true }
    }

    case 'UNGROUP_GROUP': {
      const tabIds = (message.payload as { tabIds: number[] })?.tabIds || []
      await ungroupGroupTabs(tabIds)
      return { ok: true }
    }

    case 'SPLIT_GROUP': {
      const groupId = (message.payload as { groupId: number })?.groupId
      if (!groupId) return { error: 'Missing groupId' }
      const group = await chrome.tabGroups.get(groupId)
      await broadcastAIStart(group.windowId, 'SPLIT_CURRENT_GROUP')
      try {
        const overrides = getAIOverrides(message.payload)
        await splitGroup(groupId, overrides)
        await broadcastAIComplete(group.windowId, 'SPLIT_CURRENT_GROUP')
      } catch (err: any) {
        await broadcastAIFailed(group.windowId, 'SPLIT_CURRENT_GROUP', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'MERGE_GROUP': {
      const groupId = (message.payload as { groupId: number })?.groupId
      if (!groupId) return { error: 'Missing groupId' }
      const group = await chrome.tabGroups.get(groupId)
      await broadcastAIStart(group.windowId, 'MERGE_CURRENT_GROUP')
      try {
        const overrides = getAIOverrides(message.payload)
        await mergeGroup(groupId, overrides)
        await broadcastAIComplete(group.windowId, 'MERGE_CURRENT_GROUP')
      } catch (err: any) {
        await broadcastAIFailed(group.windowId, 'MERGE_CURRENT_GROUP', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'SPLIT_CURRENT_GROUP': {
      const windowId = await resolveWindowId(message.payload)
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      if (activeTab?.groupId !== undefined && activeTab.groupId !== TAB_GROUP_ID_NONE) {
        await broadcastAIStart(windowId, 'SPLIT_CURRENT_GROUP')
        try {
          const overrides = getAIOverrides(message.payload)
          await splitGroup(activeTab.groupId, overrides)
          await broadcastAIComplete(windowId, 'SPLIT_CURRENT_GROUP')
        } catch (err: any) {
          await broadcastAIFailed(windowId, 'SPLIT_CURRENT_GROUP', err.message || String(err))
          return { error: err.message || String(err) }
        }
      } else {
        return { error: 'Active tab is not in a group' }
      }
      return { ok: true }
    }

    case 'MERGE_CURRENT_GROUP': {
      const windowId = await resolveWindowId(message.payload)
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      if (activeTab?.groupId !== undefined && activeTab.groupId !== TAB_GROUP_ID_NONE) {
        await broadcastAIStart(windowId, 'MERGE_CURRENT_GROUP')
        try {
          const overrides = getAIOverrides(message.payload)
          await mergeGroup(activeTab.groupId, overrides)
          await broadcastAIComplete(windowId, 'MERGE_CURRENT_GROUP')
        } catch (err: any) {
          await broadcastAIFailed(windowId, 'MERGE_CURRENT_GROUP', err.message || String(err))
          return { error: err.message || String(err) }
        }
      } else {
        return { error: 'Active tab is not in a group' }
      }
      return { ok: true }
    }

    case 'CLASSIFY_NEW_TABS': {
      const windowId = await resolveWindowId(message.payload)
      setActiveOperation(windowId, 'classify')
      await broadcastAIStart(windowId, 'CLASSIFY_NEW_TABS')
      try {
        const overrides = getAIOverrides(message.payload)
        await classifyNewTabs(windowId, overrides)
        await broadcastAIComplete(windowId, 'CLASSIFY_NEW_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'CLASSIFY_NEW_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'GROUP_TABS_SINGLE': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId, { batchSize: 9999 })
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'GROUP_TABS_GEMINI_FLASH': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId, { provider: 'gemini', model: 'gemini-3.5-flash' })
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'GROUP_TABS_GEMINI_2_5_FLASH': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId, { provider: 'gemini', model: 'gemini-2.5-flash' })
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'GROUP_TABS_GPT_MINI': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId, { provider: 'openai', model: 'gpt-4o-mini' })
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'GROUP_TABS_GPT_4O': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId, { provider: 'openai', model: 'gpt-4o' })
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'GROUP_TABS_CLAUDE_SONNET': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId, { provider: 'claude', model: 'claude-3-5-sonnet-20240620' })
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'CLASSIFY_NEW_TABS_GEMINI': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'CLASSIFY_NEW_TABS')
      try {
        await classifyNewTabs(windowId, { provider: 'gemini', model: 'gemini-3.5-flash' })
        await broadcastAIComplete(windowId, 'CLASSIFY_NEW_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'CLASSIFY_NEW_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'CLASSIFY_NEW_TABS_GPT': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'CLASSIFY_NEW_TABS')
      try {
        await classifyNewTabs(windowId, { provider: 'openai', model: 'gpt-4o-mini' })
        await broadcastAIComplete(windowId, 'CLASSIFY_NEW_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'CLASSIFY_NEW_TABS', err.message || String(err))
        return { error: err.message || String(err) }
      }
      return { ok: true }
    }

    case 'CLOSE_DUPLICATES': {
      const windowId = await resolveWindowId(message.payload)
      await closeDuplicateTabs(windowId)
      return { ok: true }
    }

    case 'CLOSE_POSSIBLE_DUPLICATES': {
      const windowId = await resolveWindowId(message.payload)
      await closePossibleDuplicateTabs(windowId)
      return { ok: true }
    }

    case 'ORGANIZE_POSSIBLE_DUPLICATES': {
      const windowId = await resolveWindowId(message.payload)
      await organizePossibleDuplicateGroups(windowId)
      return { ok: true }
    }

    case 'GROUP_CLUSTER': {
      const { tabIds, title } = (message.payload as { tabIds: number[]; title: string }) || {}
      if (Array.isArray(tabIds) && tabIds.length > 0) {
        const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] })
        if (title) {
          await chrome.tabGroups.update(groupId, { title, color: 'orange' })
        }
      }
      return { ok: true }
    }

    case 'CLOSE_DOMAIN': {
      const windowId = await resolveWindowId(message.payload)
      await closeDomainTabs(windowId)
      return { ok: true }
    }

    case 'ISOLATE_DOMAIN': {
      const windowId = await resolveWindowId(message.payload)
      await isolateDomainTabs(windowId)
      return { ok: true }
    }

    case 'SORT_TABS': {
      const windowId = await resolveWindowId(message.payload)
      await sortTabsByDomainAndTitle(windowId)
      return { ok: true }
    }

    case 'SORT_GROUPS_BY_NAME': {
      const windowId = await resolveWindowId(message.payload)
      await sortGroupsByName(windowId)
      return { ok: true }
    }

    case 'SORT_GROUPS_BY_SIZE': {
      const windowId = await resolveWindowId(message.payload)
      await sortGroupsBySize(windowId)
      return { ok: true }
    }

    case 'MERGE_WINDOWS': {
      const windowId = await resolveWindowId(message.payload)
      await mergeAllWindows(windowId)
      return { ok: true }
    }

    case 'MUTE_ALL': {
      const windowId = await resolveWindowId(message.payload)
      await muteAllTabs(windowId)
      return { ok: true }
    }

    case 'UNMUTE_ALL': {
      const windowId = await resolveWindowId(message.payload)
      await unmuteAllTabs(windowId)
      return { ok: true }
    }

    case 'CLOSE_LEFT': {
      const windowId = await resolveWindowId(message.payload)
      await closeLeftTabs(windowId)
      return { ok: true }
    }

    case 'CLOSE_RIGHT': {
      const windowId = await resolveWindowId(message.payload)
      await closeRightTabs(windowId)
      return { ok: true }
    }

    case 'CANCEL_OPERATION': {
      const windowId = await resolveWindowId(message.payload)
      cancelActiveOperation(windowId)
      return { ok: true }
    }

    case 'EXPAND_ALL_GROUPS': {
      const windowId = await resolveWindowId(message.payload)
      await expandAllGroups(windowId)
      return { ok: true }
    }

    case 'COLLAPSE_ALL_GROUPS': {
      const windowId = await resolveWindowId(message.payload)
      await collapseAllGroups(windowId)
      return { ok: true }
    }

    case 'TOGGLE_GROUP_TITLES': {
      const windowId = await resolveWindowId(message.payload)
      const hidden = await toggleGroupTitles(windowId)
      return { ok: true, hidden }
    }

    case 'GET_GROUPS_PREVIEW': {
      const windowId = await resolveWindowId(message.payload)
      return await getGroupsPreview(windowId)
    }

    case 'REFRESH_GROUPS_PREVIEW': {
      const windowId = await resolveWindowId(message.payload)
      return await getGroupsPreview(windowId, true)
    }

    case 'GET_ALL_WINDOWS_PREVIEW': {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
      const result: WindowGroupsInfo[] = await Promise.all(
        windows.map(async (win) => {
          const wid = win.id!
          const groups = await getGroupsPreview(wid)
          const tabs = await chrome.tabs.query({ windowId: wid })
          const hasGroups = typeof chrome.tabGroups !== 'undefined' && tabs.some(
            (t) => t.groupId !== TAB_GROUP_ID_NONE,
          )
          return {
            windowId: wid,
            tabCount: tabs.length,
            unpinnedTabCount: tabs.filter(t => !t.pinned).length,
            focused: !!win.focused,
            groups,
            hasGroups,
            titlesHidden: areGroupTitlesHidden(wid),
          }
        }),
      )
      return result
    }

    case 'SEARCH_TABS': {
      const payload = message.payload as { query: string; windowId?: number } | undefined
      const query = payload?.query ?? ''
      const currentWindowId = payload?.windowId ?? sender?.tab?.windowId
      const tabs = await chrome.tabs.query({})
      let tabGroups: chrome.tabGroups.TabGroup[] = []
      if (typeof chrome.tabGroups !== 'undefined') {
        tabGroups = await chrome.tabGroups.query({})
      }
      const groupMap = new Map<number, chrome.tabGroups.TabGroup>()
      for (const g of tabGroups) {
        groupMap.set(g.id, g)
      }
      const openTabs: TabInfo[] = tabs
        .filter((t) => t.id !== undefined)
        .map((t) => {
          const groupId = t.groupId !== -1 && typeof chrome.tabGroups !== 'undefined' && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? t.groupId : undefined
          const group = groupId ? groupMap.get(groupId) : undefined
          return {
            id: t.id!,
            url: t.url || '',
            title: t.title || '',
            favIconUrl: t.favIconUrl,
            windowId: t.windowId,
            index: t.index,
            active: t.active,
            pinned: t.pinned,
            lastAccessed: t.lastAccessed,
            groupId,
            groupTitle: group?.title,
            groupColor: group?.color,
          }
        })
      const history = await getHistoryEntries()
      return searchTabs(query, openTabs, history, currentWindowId)
    }

    case 'GET_SETTINGS': {
      const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
      const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
      return { 
        ...DEFAULT_SETTINGS, 
        ...saved,
        ai: { ...DEFAULT_SETTINGS.ai, ...saved?.ai },
      }
    }

    case 'SAVE_SETTINGS': {
      const newSettings = message.payload as ExtensionSettings
      await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: newSettings })
      invalidatePreviewCache()
      await chrome.action.setPopup({ popup: newSettings.useSearchPopup ? 'src/popup/search.html' : 'src/popup/index.html' })
      return { ok: true }
    }

    case 'SWITCH_TAB': {
      const tabId = (message.payload as { tabId: number })?.tabId
      if (tabId) {
        try {
          const tab = await chrome.tabs.get(tabId)
          await chrome.tabs.update(tabId, { active: true })
          if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true })
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err)
          if (!errMsg.includes('No tab with id') && !errMsg.includes('Invalid tab id')) {
            console.error('[timTabTool] Failed to switch tab:', err)
          }
        }
      }
      return { ok: true }
    }

    case 'CLOSE_TAB': {
      const tabId = (message.payload as { tabId: number })?.tabId
      if (tabId) {
        try {
          await chrome.tabs.remove(tabId)
        } catch (err: any) {
          const errMsg = err?.message || String(err)
          if (!errMsg.includes('No tab with id') && !errMsg.includes('Invalid tab id')) {
            console.error('[timTabTool] Failed to close tab:', err)
          }
        }
      }
      return { ok: true }
    }

    case 'OPEN_URL': {
      const url = (message.payload as { url: string })?.url
      if (url) {
        await chrome.tabs.create({ url })
      }
      return { ok: true }
    }

    case 'GET_ACTIVE_OPERATIONS': {
      return getActiveOperations()
    }

    case 'GET_SEARCH_OVERLAY_METRICS': {
      const windowId = await resolveWindowId(message.payload)
      const tabs = await chrome.tabs.query({ windowId })
      const unpinnedTabsCount = tabs.filter(t => !t.pinned).length
      
      // Get current active tab group ID and tabs count
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      let currentGroupTabsCount = 0
      if (activeTab?.groupId !== undefined && typeof chrome.tabGroups !== 'undefined' && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        currentGroupTabsCount = tabs.filter(t => t.groupId === activeTab.groupId).length
      }

      // Logik: Ermittelt die Anzahl der neuen Tabs (alle ungruppierten Tabs, ausgenommen angepinnte Tabs)
      // Programming logic: Get new tabs count (tabs not in any group, excluding pinned)
      let newTabsCount = 0
      if (typeof chrome.tabGroups !== 'undefined') {
        newTabsCount = tabs.filter(t => {
          if (t.id === undefined || t.pinned) return false
          return t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE
        }).length
      } else {
        newTabsCount = unpinnedTabsCount
      }

      // Get AI Settings
      const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
      const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
      const aiSettings = { 
        ...DEFAULT_SETTINGS.ai, 
        ...saved?.ai,
      }

      const activeOps = getActiveOperations()
      const activeOperation = activeOps[windowId] || null

      return {
        unpinnedTabsCount,
        currentGroupTabsCount,
        newTabsCount,
        aiSettings,
        activeOperation,
      }
    }

    case 'CLEAR_OPERATION_ERROR': {
      const windowId = (message.payload as { windowId: number })?.windowId
      if (windowId) {
        clearOperationError(windowId)
      }
      return { ok: true }
    }

    case 'TOGGLE_SEARCH_OVERLAY': {
      const payload = message.payload as { initialQuery?: string } | undefined
      await toggleSearchOverlay(payload?.initialQuery || '')
      return { ok: true }
    }

    case 'GET_MCP_STATUS': {
      return getMCPStatus()
    }

    case 'RECONNECT_MCP': {
      reconnectMCP()
      return { ok: true }
    }

    default:
      return { error: 'Unknown action' }
  }
}

// Start the MCP bridge server listener
initMCPBridge()

