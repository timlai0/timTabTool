import {
  groupAllTabs,
  ungroupAllTabs,
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
  clearOperationError,
  splitGroup,
  mergeGroup,
} from './tab-manager'
import { searchTabs } from './searcher'
import { recordTabVisit, getHistoryEntries } from './storage'
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants'
import type { ExtensionMessage, TabInfo, ExtensionSettings, WindowGroupsInfo } from '../shared/types'

console.log('[TabPilot] Service worker started')

chrome.runtime.onInstalled.addListener(() => {
  console.log('[TabPilot] Extension installed')
})

// --- Tab history tracking + cache updates ---
chrome.tabs.onCreated.addListener((tab) => {
  cacheAddTab(tab)
  if (tab.windowId !== undefined) debouncedCacheRebuild(tab.windowId)
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.title) {
    recordTabVisit(tab.url, tab.title, tab.favIconUrl)
    cacheUpdateTab(tab)
    autoGroupNewTab(tab).catch((err) =>
      console.error('[TabPilot] autoGroupNewTab failed:', err),
    )
  } else if (changeInfo.url) {
    cacheUpdateTab(tab)
  }
  if (tab.windowId !== undefined) debouncedCacheRebuild(tab.windowId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  cacheRemoveTab(tabId)
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

// --- Command handler (keyboard shortcut) ---
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-search') {
    await toggleSearchOverlay()
  }
})

async function ensureContentScriptLoaded(tabId: number): Promise<void> {
  let isLoaded = false
  try {
    const [checkResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!(window as unknown as Record<string, boolean>).__ATM_SEARCH_LOADED__,
    })
    isLoaded = !!checkResult?.result
  } catch {
    // scripting.executeScript failed — tab may not support it
  }

  // Inject content script if not loaded
  if (!isLoaded) {
    const manifest = chrome.runtime.getManifest()
    const contentScriptFiles = manifest.content_scripts?.[0]?.js || []
    if (contentScriptFiles.length > 0) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: contentScriptFiles,
      })
    }
  }
}

async function broadcastAIStart(windowId: number, action: string) {
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId })
    const activeTab = tabs[0]
    if (activeTab?.id && activeTab.url) {
      if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('about:')) return
      
      await ensureContentScriptLoaded(activeTab.id)
      await chrome.tabs.sendMessage(activeTab.id, {
        action: 'START_AI_PROGRESS',
        payload: { commandAction: action }
      })
    }
  } catch (err) {
    console.error('[TabPilot] Failed to broadcast AI start:', err)
  }
}

async function broadcastAIComplete(windowId: number, action: string) {
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId })
    const activeTab = tabs[0]
    if (activeTab?.id && activeTab.url) {
      if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('about:')) return
      
      await chrome.tabs.sendMessage(activeTab.id, {
        action: 'AI_OPERATION_COMPLETE',
        payload: { commandAction: action }
      })
    }
  } catch (err) {
    console.error('[TabPilot] Failed to broadcast AI complete:', err)
  }
}

async function broadcastAIFailed(windowId: number, action: string, errorMsg: string) {
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId })
    const activeTab = tabs[0]
    if (activeTab?.id && activeTab.url) {
      if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://') || activeTab.url.startsWith('about:')) return
      
      await chrome.tabs.sendMessage(activeTab.id, {
        action: 'AI_OPERATION_FAILED',
        payload: { commandAction: action, error: errorMsg }
      })
    }
  } catch (err) {
    console.error('[TabPilot] Failed to broadcast AI failed:', err)
  }
}

async function toggleSearchOverlay() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id || !tab.url) return
    // Skip restricted URLs where content scripts can't run
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) return

    const tabId = tab.id
    await ensureContentScriptLoaded(tabId)

    // Toggle the overlay via executeScript
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const toggleFn = (window as unknown as Record<string, () => void>).__ATM_TOGGLE_SEARCH__
        if (toggleFn) toggleFn()
      },
    })
  } catch {
    // Tab doesn't support scripting (e.g. chrome:// pages)
  }
}

// --- Message handler ---
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch((err) => {
      console.error(`[TabPilot] Error handling action "${message.action}" with payload:`, message.payload, 'Error:', err)
      sendResponse({ error: err.message })
    })
    return true
  },
)

/** Resolve window ID from message payload or last focused window (for popup context). */
async function resolveWindowId(payload: unknown): Promise<number> {
  const windowId = (payload as { windowId?: number })?.windowId
  if (windowId !== undefined && Number.isInteger(windowId)) return windowId
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
  return win.id ?? -1
}

async function handleMessage(message: ExtensionMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.action) {
    case 'GROUP_TABS': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'GROUP_TABS')
      try {
        await groupAllTabs(windowId)
        await broadcastAIComplete(windowId, 'GROUP_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'GROUP_TABS', err.message || String(err))
        throw err
      }
      return { ok: true }
    }

    case 'UNGROUP_ALL': {
      const windowId = await resolveWindowId(message.payload)
      await ungroupAllTabs(windowId)
      invalidatePreviewCache(windowId)
      return { ok: true }
    }

    case 'CLOSE_GROUP': {
      const tabIds = (message.payload as { tabIds: number[] })?.tabIds || []
      await closeGroupTabs(tabIds)
      return { ok: true }
    }

    case 'SPLIT_GROUP': {
      const groupId = (message.payload as { groupId: number })?.groupId
      if (!groupId) throw new Error('Missing groupId')
      const group = await chrome.tabGroups.get(groupId)
      await broadcastAIStart(group.windowId, 'SPLIT_CURRENT_GROUP')
      try {
        await splitGroup(groupId)
        await broadcastAIComplete(group.windowId, 'SPLIT_CURRENT_GROUP')
      } catch (err: any) {
        await broadcastAIFailed(group.windowId, 'SPLIT_CURRENT_GROUP', err.message || String(err))
        throw err
      }
      return { ok: true }
    }

    case 'MERGE_GROUP': {
      const groupId = (message.payload as { groupId: number })?.groupId
      if (!groupId) throw new Error('Missing groupId')
      const group = await chrome.tabGroups.get(groupId)
      await broadcastAIStart(group.windowId, 'MERGE_CURRENT_GROUP')
      try {
        await mergeGroup(groupId)
        await broadcastAIComplete(group.windowId, 'MERGE_CURRENT_GROUP')
      } catch (err: any) {
        await broadcastAIFailed(group.windowId, 'MERGE_CURRENT_GROUP', err.message || String(err))
        throw err
      }
      return { ok: true }
    }

    case 'SPLIT_CURRENT_GROUP': {
      const windowId = await resolveWindowId(message.payload)
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      if (activeTab?.groupId !== undefined && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await broadcastAIStart(windowId, 'SPLIT_CURRENT_GROUP')
        try {
          await splitGroup(activeTab.groupId)
          await broadcastAIComplete(windowId, 'SPLIT_CURRENT_GROUP')
        } catch (err: any) {
          await broadcastAIFailed(windowId, 'SPLIT_CURRENT_GROUP', err.message || String(err))
          throw err
        }
      } else {
        throw new Error('Active tab is not in a group')
      }
      return { ok: true }
    }

    case 'MERGE_CURRENT_GROUP': {
      const windowId = await resolveWindowId(message.payload)
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      if (activeTab?.groupId !== undefined && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await broadcastAIStart(windowId, 'MERGE_CURRENT_GROUP')
        try {
          await mergeGroup(activeTab.groupId)
          await broadcastAIComplete(windowId, 'MERGE_CURRENT_GROUP')
        } catch (err: any) {
          await broadcastAIFailed(windowId, 'MERGE_CURRENT_GROUP', err.message || String(err))
          throw err
        }
      } else {
        throw new Error('Active tab is not in a group')
      }
      return { ok: true }
    }

    case 'CLASSIFY_NEW_TABS': {
      const windowId = await resolveWindowId(message.payload)
      await broadcastAIStart(windowId, 'CLASSIFY_NEW_TABS')
      try {
        await classifyNewTabs(windowId)
        await broadcastAIComplete(windowId, 'CLASSIFY_NEW_TABS')
      } catch (err: any) {
        await broadcastAIFailed(windowId, 'CLASSIFY_NEW_TABS', err.message || String(err))
        throw err
      }
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
          const hasGroups = tabs.some(
            (t) => t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE,
          )
          return {
            windowId: wid,
            tabCount: tabs.length,
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
      const openTabs: TabInfo[] = tabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({
          id: t.id!,
          url: t.url || '',
          title: t.title || '',
          favIconUrl: t.favIconUrl,
          windowId: t.windowId,
          index: t.index,
          active: t.active,
          pinned: t.pinned,
          lastAccessed: t.lastAccessed,
        }))
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
      return { ok: true }
    }

    case 'SWITCH_TAB': {
      const tabId = (message.payload as { tabId: number })?.tabId
      if (tabId) {
        const tab = await chrome.tabs.get(tabId)
        await chrome.tabs.update(tabId, { active: true })
        if (tab.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true })
        }
      }
      return { ok: true }
    }

    case 'CLOSE_TAB': {
      const tabId = (message.payload as { tabId: number })?.tabId
      if (tabId) {
        await chrome.tabs.remove(tabId)
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
      if (activeTab?.groupId !== undefined && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        currentGroupTabsCount = tabs.filter(t => t.groupId === activeTab.groupId).length
      }

      // Get new tabs count (tabs in the "New Tabs" group)
      const allGroups = await chrome.tabGroups.query({ windowId })
      const newTabsGroup = allGroups.find(
        (g) => g.title === 'New Tabs'
      )
      const newTabsCount = newTabsGroup ? tabs.filter(t => t.groupId === newTabsGroup.id).length : 0

      // Get AI Settings
      const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
      const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
      const aiSettings = { 
        ...DEFAULT_SETTINGS.ai, 
        ...saved?.ai,
      }

      return {
        unpinnedTabsCount,
        currentGroupTabsCount,
        newTabsCount,
        aiSettings,
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
      await toggleSearchOverlay()
      return { ok: true }
    }

    default:
      return { error: 'Unknown action' }
  }
}
