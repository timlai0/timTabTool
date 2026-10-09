'use strict';

import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../../shared/constants'
import { extractDomain } from '../../shared/utils'
import type { ExtensionSettings } from '../../shared/types'

export const TAB_RETRY_ATTEMPTS = 3
export const TAB_RETRY_DELAY_MS = 200

export function isTabGroupsSupported(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.tabGroups !== 'undefined'
}

export const TAB_GROUP_ID_NONE = isTabGroupsSupported() ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1

export const RESTRICTED_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'moz-extension://', 'about:', 'edge://']

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true
  return RESTRICTED_URL_PREFIXES.some((p) => url.startsWith(p))
}

// Maps Chrome groupId → stored display title (used to enforce persistent titles)
export const groupTitleMap = new Map<number, string>()
// Tracks groups currently being updated by us to prevent infinite loops
export const updatingGroups = new Set<number>()
// Per-window: whether group titles are hidden in Chrome tab bar
export const titlesHiddenMap = new Map<number, boolean>()

export async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
  const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    ai: { ...DEFAULT_SETTINGS.ai, ...saved.ai },
  }
}

export async function retryTabOperation<T>(fn: () => Promise<T>): Promise<T> {
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
  throw new Error('Tab operation failed after retries')
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
