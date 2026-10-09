'use strict';

import '../shared/polyfill'

import {
  updateNewTabsBadge,
  debouncedUpdateNewTabsBadge,
  initLiveTabTracker,
  trackLiveTab,
  recordTabCreatedTime,
  removeTabCreatedTime,
  handleTabRemovalForMassClose,
  cacheAddTab,
  cacheUpdateTab,
  cacheRemoveTab,
  debouncedCacheRebuild,
  clearWindowCache,
  autoGroupNewTab,
  handleTabGroupUpdated,
  handleTabGroupRemoved,
  ungroupAllTabs,
  groupAllTabs,
  cleanupTabGroups,
} from './tab-manager'
import { recordTabVisit } from './storage'
import { STORAGE_KEYS } from '../shared/constants'
import type { ExtensionMessage, ExtensionSettings } from '../shared/types'
import { initMCPBridge } from './mcp-bridge'
import {
  toggleSearchOverlay,
  focusExistingSearchTabOrWindow,
  openSearchInNewWindow,
  focusExistingChatTabOrWindow,
  openChatInNewWindow,
  openChatInNewTab,
} from './ipc-broadcast'
import {
  handleExtensionMessage,
  resolveWindowId,
  getAIOverrides,
} from './message-router'

// Re-export helpers for backward compatibility and test access
export { resolveWindowId, getAIOverrides }
export {
  toggleSearchOverlay,
  focusExistingSearchTabOrWindow,
  openSearchInNewWindow,
  focusExistingChatTabOrWindow,
  openChatInNewWindow,
  openChatInNewTab,
} from './ipc-broadcast'

console.log('[timTabTool] Service worker started')

// Initialize badge state and tab tracking
updateNewTabsBadge().catch(console.error)
initLiveTabTracker().catch(console.error)

if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    updateNewTabsBadge().catch(console.error)
    setupContextMenus()
    initLiveTabTracker().catch(console.error)
  })
}

chrome.storage.local.get(STORAGE_KEYS.SETTINGS).then((data) => {
  const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
  if (chrome.action?.setPopup) {
    chrome.action.setPopup({ popup: saved.useSearchPopup ? 'src/popup/search.html' : 'src/popup/index.html' })
  }
}).catch(console.error)

/**
 * Setup extension context menus safely across both Chrome and Firefox.
 * Logic: Clears existing menus before recreating to avoid duplicate ID errors.
 * Ensures the top-level items on the action context stay within the browser limit (max 6).
 */
export function setupContextMenus(): void {
  const menus = typeof chrome !== 'undefined' && chrome.contextMenus ? chrome.contextMenus : null
  if (!menus || typeof menus.removeAll !== 'function' || typeof menus.create !== 'function') {
    return
  }

  menus.removeAll(() => {
    if (chrome.runtime?.lastError) {
      console.debug('[timTabTool] Error clearing context menus:', chrome.runtime.lastError.message)
    }

    const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('firefox')

    const createSafe = (properties: chrome.contextMenus.CreateProperties) => {
      try {
        menus.create(properties, () => {
          if (chrome.runtime?.lastError) {
            console.debug(`[timTabTool] contextMenu create (${properties.id}):`, chrome.runtime.lastError.message)
          }
        })
      } catch (err) {
        console.debug(`[timTabTool] contextMenu create exception (${properties.id}):`, err)
      }
    }

    const getMsg = (key: string, fallback: string) => {
      try {
        return (typeof chrome !== 'undefined' && chrome.i18n?.getMessage)
          ? chrome.i18n.getMessage(key) || fallback
          : fallback
      } catch {
        return fallback
      }
    }

    // Top-level item 1: Search parent (action context)
    createSafe({
      id: 'search-parent',
      title: getMsg('contextMenuSearchTabs', 'Search Tabs'),
      contexts: ['action']
    })

    // Submenu items under search-parent
    createSafe({
      id: 'open-search-menu',
      parentId: 'search-parent',
      title: getMsg('contextMenuOpenSearch', 'Quick Search Overlay'),
      contexts: ['action']
    })

    createSafe({
      id: 'open-search-window',
      parentId: 'search-parent',
      title: getMsg('contextMenuOpenSearchWindow', 'Search in New Window'),
      contexts: ['action']
    })

    createSafe({
      id: 'open-search-tab',
      parentId: 'search-parent',
      title: getMsg('contextMenuOpenSearchTab', 'Search in New Tab'),
      contexts: ['action']
    })

    // Quick Search on in-page context menu
    createSafe({
      id: 'open-search-page',
      title: getMsg('contextMenuOpenSearch', 'Quick Search Overlay'),
      contexts: ['page']
    })

    // Top-level item 2: Window Chat parent (action context)
    createSafe({
      id: 'chat-parent',
      title: getMsg('contextMenuWindowChat', 'Window Chat'),
      contexts: ['action']
    })

    // Submenu items under chat-parent
    createSafe({
      id: 'open-chat-window',
      parentId: 'chat-parent',
      title: getMsg('contextMenuOpenChatWindow', 'Chat in New Window'),
      contexts: ['action']
    })

    createSafe({
      id: 'open-chat-tab',
      parentId: 'chat-parent',
      title: getMsg('contextMenuOpenChatTab', 'Chat in New Tab'),
      contexts: ['action']
    })

    // Window Chat on in-page context menu
    createSafe({
      id: 'open-chat-page',
      title: getMsg('contextMenuWindowChat', 'Window Chat'),
      contexts: ['page']
    })

    // Top-level item 3: Group all tabs (AI)
    createSafe({
      id: 'group-all',
      title: getMsg('contextMenuGroupAll', 'Group Tabs (AI)'),
      contexts: ['action']
    })

    // Top-level item 4: Clean up tab groups
    createSafe({
      id: 'cleanup-groups',
      title: getMsg('contextMenuCleanupGroups', 'Clean Up Tab Groups'),
      contexts: ['action']
    })

    // Top-level item 5: Ungroup all tabs
    createSafe({
      id: 'ungroup-all',
      title: getMsg('contextMenuUngroupAll', 'Ungroup All Tabs'),
      contexts: ['action']
    })

    // Top-level item 6 (Firefox only): Move tab to other window
    if (isFirefox) {
      createSafe({
        id: 'move-to-other-window',
        title: getMsg('contextMenuMoveToOtherWindow', 'Move Tab to Other Window'),
        contexts: ['action']
      })
    }
  })
}

// Initialize context menus on service worker / background startup
setupContextMenus()

chrome.runtime.onInstalled.addListener(() => {
  console.log('[timTabTool] Extension installed')
  updateNewTabsBadge().catch(console.error)
  setupContextMenus()
  initLiveTabTracker().catch(console.error)
})

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-search-menu' || info.menuItemId === 'open-search-page') {
    await toggleSearchOverlay()
  } else if (info.menuItemId === 'open-search-window') {
    if (!(await focusExistingSearchTabOrWindow())) {
      await openSearchInNewWindow()
    }
  } else if (info.menuItemId === 'open-search-tab') {
    if (!(await focusExistingSearchTabOrWindow())) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/search.html'), pinned: true })
    }
  } else if (
    info.menuItemId === 'open-chat-window' ||
    info.menuItemId === 'open-chat-page' ||
    info.menuItemId === 'chat-parent' ||
    info.menuItemId === 'open-chat-menu'
  ) {
    const windowId = tab?.windowId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId
    if (!(await focusExistingChatTabOrWindow())) {
      await openChatInNewWindow(windowId)
    }
  } else if (info.menuItemId === 'open-chat-tab') {
    const windowId = tab?.windowId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.windowId
    if (!(await focusExistingChatTabOrWindow())) {
      await openChatInNewTab(windowId)
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
  } else if (info.menuItemId === 'move-to-other-window') {
    const currentTab = tab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
    if (currentTab?.id) {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
      const otherWindows = windows.filter(w => w.id !== undefined && w.id !== currentTab.windowId)
      if (otherWindows.length > 0) {
        await chrome.tabs.move(currentTab.id, { windowId: otherWindows[0].id!, index: -1 })
        await chrome.windows.update(otherWindows[0].id!, { focused: true })
        await chrome.tabs.update(currentTab.id, { active: true })
      } else {
        await chrome.windows.create({ tabId: currentTab.id, type: 'normal', focused: true })
      }
    }
  }
})

// Tab history tracking + cache updates
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) recordTabCreatedTime(tab.id)
  cacheAddTab(tab)
  trackLiveTab(tab)
  if (tab.windowId !== undefined) debouncedCacheRebuild(tab.windowId)
})

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  trackLiveTab(tab)
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

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  removeTabCreatedTime(tabId)
  cacheRemoveTab(tabId)
  handleTabRemovalForMassClose(tabId, removeInfo)
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
  if (activeInfo.windowId !== undefined) {
    debouncedUpdateNewTabsBadge(activeInfo.windowId)
  }
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    if (tab.url && tab.title) {
      recordTabVisit(tab.url, tab.title, tab.favIconUrl)
    }
  } catch {
    // Tab may have been removed
  }
})

if (typeof chrome !== 'undefined' && typeof chrome.windows !== 'undefined' && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId !== chrome.windows.WINDOW_ID_NONE) {
      debouncedUpdateNewTabsBadge(windowId)
    }
  })
}

// Tab group lifecycle listeners
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

// Command handler (keyboard shortcuts)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-search') {
    await toggleSearchOverlay()
  } else if (command === 'open-search-slash') {
    await toggleSearchOverlay('/')
  }
})

// Extension runtime message dispatcher
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleExtensionMessage(message, sender).then(sendResponse).catch((err) => {
      console.error(`[timTabTool] Error handling action "${message.action}" with payload:`, message.payload, 'Error:', err)
      sendResponse({ error: err.message })
    })
    return true
  },
)

// MCP bridge listener initialization
initMCPBridge()
