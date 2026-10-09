'use strict';

import { detectDuplicateTabs } from '../../shared/duplicate-detector'
import { isAnyAIOperationRunning, activeAIOperationWindows } from './operation-registry'

const CACHE_DEBOUNCE_MS = 300

export const badgeTimeoutsByWindow = new Map<number, ReturnType<typeof setTimeout>>()
export let globalBadgeTimeout: ReturnType<typeof setTimeout> | null = null

export async function setAIBadge(windowId?: number): Promise<void> {
  if (windowId !== undefined) {
    activeAIOperationWindows.add(windowId)
  }
  if (typeof chrome !== 'undefined' && chrome.action) {
    try {
      await chrome.action.setBadgeText({ text: 'AI' })
      await chrome.action.setBadgeBackgroundColor({ color: '#8B5CF6' })
    } catch {
      // Ignore
    }
  }
}

export async function updateNewTabsBadge(windowId?: number): Promise<void> {
  if (isAnyAIOperationRunning()) {
    await setAIBadge()
    return
  }

  if (typeof chrome === 'undefined' || !chrome.action || !chrome.tabs) {
    return
  }

  try {
    let tabs: chrome.tabs.Tab[] = []
    if (windowId !== undefined) {
      try {
        tabs = await chrome.tabs.query({ windowId })
      } catch {
        tabs = []
      }
    }

    if (tabs.length === 0) {
      try {
        const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        if (activeTabs.length > 0 && activeTabs[0].windowId !== undefined) {
          tabs = await chrome.tabs.query({ windowId: activeTabs[0].windowId })
        } else {
          tabs = await chrome.tabs.query({})
        }
      } catch {
        tabs = []
      }
    }

    const result = detectDuplicateTabs(tabs)
    const duplicateCount = result.exactDuplicateCount

    await chrome.action.setBadgeText({ text: duplicateCount > 0 ? String(duplicateCount) : '' })
    await chrome.action.setBadgeBackgroundColor({ color: duplicateCount > 0 ? 'red' : '#6B7280' })
  } catch (err) {
    console.error('[timTabTool] Failed to update badge:', err)
    try {
      await chrome.action.setBadgeText({ text: '' })
    } catch {
      // Ignore
    }
  }
}

export function debouncedUpdateNewTabsBadge(windowId?: number): void {
  if (windowId !== undefined) {
    const existing = badgeTimeoutsByWindow.get(windowId)
    if (existing) clearTimeout(existing)
    badgeTimeoutsByWindow.set(
      windowId,
      setTimeout(() => {
        badgeTimeoutsByWindow.delete(windowId)
        updateNewTabsBadge(windowId).catch(console.error)
      }, CACHE_DEBOUNCE_MS)
    )
  } else {
    if (globalBadgeTimeout) clearTimeout(globalBadgeTimeout)
    globalBadgeTimeout = setTimeout(() => {
      globalBadgeTimeout = null
      updateNewTabsBadge().catch(console.error)
    }, CACHE_DEBOUNCE_MS)
  }
}
