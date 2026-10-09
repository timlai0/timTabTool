'use strict';

import { STORAGE_KEYS } from '../shared/constants'
import { isRestrictedUrl } from './tabs/tab-common'
import { registerOperationTab, unregisterOperationTab } from './operations/operation-registry'

/**
 * Ensures the search content script is loaded on the target tab before dispatching commands.
 * Logic: Checks if content script flag is already present; if missing, dynamically injects content script.
 * @param {number} tabId - Target tab ID.
 * @returns {Promise<boolean>} True if content script is loaded.
 */
export async function ensureContentScriptLoaded(tabId: number): Promise<boolean> {
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
    const contentScriptFiles = manifest.content_scripts?.[0]?.js || ['content.js']
    if (contentScriptFiles.length > 0) {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: contentScriptFiles,
      })
      return true
    }
  } catch {
    // Content script file missing or failed to load
    return false
  }
  return false
}

/**
 * Resolves the optimal tab in a window for receiving content script progress notifications.
 * Prioritizes active tab, falling back to any valid non-restricted tab in the window.
 * @param {number} windowId - Window ID.
 * @returns {Promise<chrome.tabs.Tab | undefined>} Target tab or undefined.
 */
export async function findBroadcastTargetTab(windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, windowId })
  let targetTab: chrome.tabs.Tab | undefined = tabs[0]
  if (!targetTab || !targetTab.url || isRestrictedUrl(targetTab.url)) {
    const winTabs = await chrome.tabs.query({ windowId })
    targetTab = winTabs.find(t => t.id && t.url && !isRestrictedUrl(t.url))
  }
  return targetTab
}

/**
 * Broadcasts operation start to extension views and targeted in-page content scripts.
 * @param {number} windowId - Window ID.
 * @param {string} action - Action command name.
 */
export async function broadcastAIStart(windowId: number, action: string): Promise<void> {
  try {
    const prevResultData = (await chrome.storage.local.get(STORAGE_KEYS.LAST_AI_RESULT).catch(() => ({}))) as Record<string, any>
    const prevResult = prevResultData?.[STORAGE_KEYS.LAST_AI_RESULT]
    if (prevResult && prevResult.windowId === windowId) {
      await chrome.storage.local.remove(STORAGE_KEYS.LAST_AI_RESULT)
      chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: null }).catch(() => {})
    }
    chrome.runtime.sendMessage({ action: 'START_AI_PROGRESS', payload: { windowId, commandAction: action } }).catch(() => {})

    const targetTab = await findBroadcastTargetTab(windowId)
    if (targetTab?.id && targetTab.url) {
      registerOperationTab(windowId, targetTab.id)
      const loaded = await ensureContentScriptLoaded(targetTab.id)
      if (loaded) {
        await chrome.tabs.sendMessage(targetTab.id, {
          action: 'START_AI_PROGRESS',
          payload: { windowId, commandAction: action }
        }).catch(() => {})
      }
    }
  } catch {
    // Non-critical progress broadcast error
  }
}

/**
 * Broadcasts operation completion to extension views and targeted in-page content scripts.
 * @param {number} windowId - Window ID.
 * @param {string} action - Action command name.
 */
export async function broadcastAIComplete(windowId: number, action: string): Promise<void> {
  try {
    chrome.runtime.sendMessage({ action: 'AI_OPERATION_COMPLETE', payload: { windowId, commandAction: action } }).catch(() => {})
    const targetTab = await findBroadcastTargetTab(windowId)
    if (targetTab?.id && targetTab.url) {
      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'AI_OPERATION_COMPLETE',
        payload: { windowId, commandAction: action }
      }).catch(() => {})
    }
  } catch {
    // Non-critical progress broadcast error
  } finally {
    unregisterOperationTab(windowId)
  }
}

/**
 * Broadcasts operation failure to extension views and targeted in-page content scripts.
 * @param {number} windowId - Window ID.
 * @param {string} action - Action command name.
 * @param {string} errorMsg - Error description.
 */
export async function broadcastAIFailed(windowId: number, action: string, errorMsg: string): Promise<void> {
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
    chrome.runtime.sendMessage({ action: 'AI_OPERATION_FAILED', payload: { windowId, commandAction: action, error: errorMsg } }).catch(() => {})

    const targetTab = await findBroadcastTargetTab(windowId)
    if (targetTab?.id && targetTab.url) {
      await chrome.tabs.sendMessage(targetTab.id, {
        action: 'AI_OPERATION_FAILED',
        payload: { windowId, commandAction: action, error: errorMsg }
      }).catch(() => {})
    }
  } catch {
    // Non-critical progress broadcast error
  } finally {
    unregisterOperationTab(windowId)
  }
}

/**
 * Toggles search overlay injection and activation on the currently active tab.
 * @param {string} [initialQuery=''] - Optional initial search query.
 */
export async function toggleSearchOverlay(initialQuery = ''): Promise<void> {
  try {
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tabs || tabs.length === 0) {
      tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    }
    const tab = tabs[0]
    if (!tab?.id || !tab.url) return
    if (isRestrictedUrl(tab.url)) return

    const tabId = tab.id
    await ensureContentScriptLoaded(tabId)

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

/**
 * Focuses an existing search tab or search popup window if one is open.
 * @returns {Promise<boolean>} True if an existing search view was focused.
 */
export async function focusExistingSearchTabOrWindow(): Promise<boolean> {
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

/**
 * Opens the standalone search interface in a dedicated popup window centered over the current browser window.
 */
export async function openSearchInNewWindow(): Promise<void> {
  try {
    const currentWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    const flyoutWidth = 380
    const searchMenuWidth = 680
    const totalWidth = flyoutWidth + searchMenuWidth
    const searchHeight = 550

    const mainLeft = currentWin.left ?? 0
    const mainTop = currentWin.top ?? 0
    const mainWidth = currentWin.width ?? 1024
    const mainHeight = currentWin.height ?? 768

    const searchLeft = Math.max(0, mainLeft + Math.round((mainWidth - totalWidth) / 2))
    const searchTop = Math.max(0, mainTop + Math.round((mainHeight - searchHeight) / 2))

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

/**
 * Focuses an existing chat tab or chat popup window if one is open.
 * @returns {Promise<boolean>} True if an existing chat view was focused.
 */
export async function focusExistingChatTabOrWindow(): Promise<boolean> {
  try {
    const chatBase = chrome.runtime.getURL('src/popup/index.html?view=chat')
    const allTabs = await chrome.tabs.query({})
    const existingTab = allTabs.find((tab) => tab.url && tab.url.startsWith(chatBase))
    if (existingTab && existingTab.id && existingTab.windowId) {
      await chrome.windows.update(existingTab.windowId, { focused: true })
      await chrome.tabs.update(existingTab.id, { active: true })
      return true
    }
  } catch (err) {
    console.error('[timTabTool] Failed to focus existing chat tab or window:', err)
  }
  return false
}

/**
 * Opens the Window Chat interface in a dedicated popup window centered over the current browser window.
 * @param {number} [targetWindowId] - Optional target window ID to scope chat to.
 */
export async function openChatInNewWindow(targetWindowId?: number): Promise<void> {
  try {
    const currentWin = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    const chatWidth = 440
    const chatHeight = 620

    const mainLeft = currentWin.left ?? 0
    const mainTop = currentWin.top ?? 0
    const mainWidth = currentWin.width ?? 1024
    const mainHeight = currentWin.height ?? 768

    const chatLeft = Math.max(0, mainLeft + Math.round((mainWidth - chatWidth) / 2))
    const chatTop = Math.max(0, mainTop + Math.round((mainHeight - chatHeight) / 2))

    const url = targetWindowId !== undefined
      ? chrome.runtime.getURL(`src/popup/index.html?view=chat&windowId=${targetWindowId}`)
      : chrome.runtime.getURL('src/popup/index.html?view=chat')

    await chrome.windows.create({
      url,
      type: 'popup',
      width: chatWidth,
      height: chatHeight,
      left: chatLeft,
      top: chatTop,
      focused: true
    })
  } catch (err) {
    console.error('[timTabTool] Failed to open chat in new window:', err)
  }
}

/**
 * Opens the Window Chat interface in a new pinned tab.
 * @param {number} [targetWindowId] - Optional target window ID to scope chat to.
 */
export async function openChatInNewTab(targetWindowId?: number): Promise<void> {
  try {
    const url = targetWindowId !== undefined
      ? chrome.runtime.getURL(`src/popup/index.html?view=chat&windowId=${targetWindowId}`)
      : chrome.runtime.getURL('src/popup/index.html?view=chat')

    await chrome.tabs.create({ url, pinned: true })
  } catch (err) {
    console.error('[timTabTool] Failed to open chat in new tab:', err)
  }
}
