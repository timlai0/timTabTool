'use strict';

import {
  groupAllTabs,
  ungroupAllTabs,
  ungroupGroupTabs,
  closeGroupTabs,
  classifyNewTabs,
  checkAndRegroupLast20Tabs,
  expandAllGroups,
  collapseAllGroups,
  toggleGroupTitles,
  areGroupTitlesHidden,
  getGroupsPreview,
  invalidatePreviewCache,
  cleanupTabGroups,
  splitGroup,
  mergeGroup,
  closeDuplicateTabs,
  closePossibleDuplicateTabs,
  organizePossibleDuplicateGroups,
  renameDuplicateGroups,
  generateWindowName,
  generateAllWindowsNames,
  closeDomainTabs,
  isolateDomainTabs,
  sortTabsByDomainAndTitle,
  mergeAllWindows,
  muteAllTabs,
  unmuteAllTabs,
  closeLeftTabs,
  closeRightTabs,
  getActiveOperations,
  setActiveOperation,
  clearOperationError,
  extendOperationTimeout,
  cancelActiveOperation,
  registerOperationTab,
  markTabIdsClosedByExtension,
} from './tab-manager'
import { searchTabs } from './searcher'
import { getHistoryEntries } from './storage'
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../shared/constants'
import type { ExtensionMessage, TabInfo, ExtensionSettings, WindowGroupsInfo } from '../shared/types'
import { AILogger } from '../shared/ai-logger'
import {
  recordTabIdsBeforeClose,
  getClosedTabs,
  restoreClosedTab,
  restoreAllClosedTabs,
  removeClosedTab,
  clearClosedTabs,
  restoreClosedBatch,
  removeClosedBatch,
} from '../shared/closed-tabs-manager'
import { getMCPStatus, reconnectMCP } from './mcp-bridge'
import {
  broadcastAIStart,
  broadcastAIComplete,
  broadcastAIFailed,
  toggleSearchOverlay,
  focusExistingChatTabOrWindow,
  openChatInNewWindow,
  openChatInNewTab,
} from './ipc-broadcast'

const TAB_GROUP_ID_NONE = typeof chrome !== 'undefined' && typeof chrome.tabGroups !== 'undefined'
  ? chrome.tabGroups.TAB_GROUP_ID_NONE
  : -1

/**
 * Resolve window ID from message payload, message sender, or last focused window.
 * @param {unknown} payload - The message payload containing an optional windowId.
 * @param {chrome.runtime.MessageSender} [sender] - The message sender.
 * @returns {Promise<number>} The resolved window ID.
 */
export async function resolveWindowId(payload: unknown, sender?: chrome.runtime.MessageSender): Promise<number> {
  if (typeof payload === 'number' && Number.isInteger(payload) && payload > 0) {
    return payload
  }
  if (payload && typeof payload === 'object') {
    const wid = (payload as { windowId?: unknown }).windowId
    if (typeof wid === 'number' && Number.isInteger(wid) && wid > 0) {
      return wid
    }
  }
  if (sender?.tab?.windowId && sender.tab.windowId > 0) {
    return sender.tab.windowId
  }
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null)
  return win?.id ?? chrome.windows.WINDOW_ID_NONE
}

/**
 * Parse AI override settings from the message payload.
 * @param {unknown} payload - The message payload.
 * @returns {Partial<ExtensionSettings['ai']> & { shiftKey?: boolean; verboseLog?: boolean } | undefined} Parsed overrides or undefined.
 */
export function getAIOverrides(payload: unknown): Partial<ExtensionSettings['ai']> & { shiftKey?: boolean; verboseLog?: boolean } | undefined {
  if (payload && typeof payload === 'object') {
    const p = payload as {
      provider?: unknown
      model?: unknown
      sendFullUrl?: unknown
      sendRandomOrder?: unknown
      groupingPrompt?: unknown
      customPrompt?: unknown
      windowNamingPrompt?: unknown
      shiftKey?: unknown
      verboseLog?: unknown
      bypassSafeguards?: unknown
      openRouterOnlyFree?: unknown
      openRouterByokManual?: unknown
      openRouterByokActive?: unknown
      openRouterKeyInfo?: unknown
      openrouterProvider?: unknown
      openrouterAllowFallbacks?: unknown
      openrouterSort?: unknown
      openrouterDataCollection?: unknown
      openrouterRequireParams?: unknown
      openrouterIgnoreProviders?: unknown
      openrouterFallbackModels?: unknown
      reasoningEffort?: unknown
    }
    const overrides: Partial<ExtensionSettings['ai']> & { shiftKey?: boolean; verboseLog?: boolean } = {}
    
    if (typeof p.model === 'string' && p.model !== '-full') {
      overrides.model = p.model
    }
    
    if (typeof p.provider === 'string') {
      const providerStr = p.provider
      if (providerStr === 'openai' || providerStr === 'claude' || providerStr === 'gemini' || providerStr === 'openrouter' || providerStr === 'custom') {
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

    if (typeof p.windowNamingPrompt === 'string' && p.windowNamingPrompt.trim()) {
      overrides.windowNamingPrompt = p.windowNamingPrompt.trim()
    }

    if (typeof p.bypassSafeguards === 'boolean') {
      overrides.bypassSafeguards = p.bypassSafeguards
    }

    if (typeof p.openRouterOnlyFree === 'boolean') {
      overrides.openRouterOnlyFree = p.openRouterOnlyFree
    }

    if (typeof p.openRouterByokManual === 'boolean') {
      overrides.openRouterByokManual = p.openRouterByokManual
    }

    if (typeof p.openRouterByokActive === 'boolean') {
      overrides.openRouterByokActive = p.openRouterByokActive
    }

    if (p.openRouterKeyInfo && typeof p.openRouterKeyInfo === 'object') {
      overrides.openRouterKeyInfo = p.openRouterKeyInfo as any
    }

    if (typeof p.openrouterProvider === 'string') {
      overrides.openrouterProvider = p.openrouterProvider
    }

    if (typeof p.openrouterAllowFallbacks === 'boolean') {
      overrides.openrouterAllowFallbacks = p.openrouterAllowFallbacks
    }

    if (typeof p.openrouterSort === 'string') {
      overrides.openrouterSort = p.openrouterSort as any
    }

    if (typeof p.openrouterDataCollection === 'string') {
      overrides.openrouterDataCollection = p.openrouterDataCollection as any
    }

    if (typeof p.openrouterRequireParams === 'boolean') {
      overrides.openrouterRequireParams = p.openrouterRequireParams
    }

    if (typeof p.openrouterIgnoreProviders === 'string') {
      overrides.openrouterIgnoreProviders = p.openrouterIgnoreProviders
    }

    if (typeof p.openrouterFallbackModels === 'string') {
      overrides.openrouterFallbackModels = p.openrouterFallbackModels
    }

    if (typeof p.reasoningEffort === 'string') {
      const effort = p.reasoningEffort
      if (['auto', 'minimal', 'low', 'medium', 'high', 'max'].includes(effort)) {
        overrides.reasoningEffort = effort as any
      }
    }

    if (typeof p.shiftKey === 'boolean') {
      overrides.shiftKey = p.shiftKey
    }

    if (typeof p.verboseLog === 'boolean') {
      overrides.verboseLog = p.verboseLog
    }
    
    if (Object.keys(overrides).length > 0) {
      return overrides
    }
  }
  return undefined
}

/**
 * Standardized AI operation runner with lifecycle broadcasting and error handling.
 * Eliminates repetitive try-catch blocks across grouping and classification actions.
 */
async function runAIOperation<T>(
  windowId: number,
  actionName: string,
  opType: 'group' | 'classify' | 'regroup' | 'rename' | 'name_window' | null,
  opFn: () => Promise<T>,
): Promise<{ ok: true; result?: T } | { error: string }> {
  if (opType) {
    setActiveOperation(windowId, opType)
  }
  await broadcastAIStart(windowId, actionName)
  try {
    const result = await opFn()
    await broadcastAIComplete(windowId, actionName)
    return result !== undefined ? { ok: true, result } : { ok: true }
  } catch (err: any) {
    const errorMsg = err?.message || String(err)
    await broadcastAIFailed(windowId, actionName, errorMsg)
    return { error: errorMsg }
  }
}

/**
 * Handles AI log retrieval and management messages.
 */
async function handleAILogMessages(action: string, payload: unknown): Promise<unknown> {
  switch (action) {
    case 'GET_AI_LOGS': {
      const activeOpsMap = getActiveOperations()
      const activeWindowIds = new Set(Object.keys(activeOpsMap).filter(id => activeOpsMap[Number(id)]?.type).map(Number))
      const logs = await AILogger.cleanOrphanedRunningLogs(activeWindowIds)
      return { ok: true, logs }
    }
    case 'CLEAR_AI_LOGS': {
      await AILogger.clearLogs()
      return { ok: true }
    }
    case 'DELETE_AI_LOG': {
      const id = (payload as { id?: string })?.id
      if (id) await AILogger.deleteLog(id)
      return { ok: true }
    }
    default:
      return null
  }
}

/**
 * Handles closed tab tracking and restoration messages.
 */
async function handleClosedTabMessages(action: string, payload: unknown): Promise<unknown> {
  switch (action) {
    case 'GET_CLOSED_TABS': {
      const tabs = await getClosedTabs()
      return { ok: true, tabs }
    }
    case 'RESTORE_CLOSED_TAB': {
      const id = (payload as { id?: string })?.id
      const windowId = (payload as { windowId?: number })?.windowId
      if (!id) return { error: 'Missing closed tab id' }
      const tab = await restoreClosedTab(id, windowId)
      return { ok: true, tab }
    }
    case 'RESTORE_CLOSED_BATCH': {
      const batchId = (payload as { batchId?: string })?.batchId
      const windowId = (payload as { windowId?: number })?.windowId
      if (!batchId) return { error: 'Missing closed batch id' }
      const count = await restoreClosedBatch(batchId, windowId)
      return { ok: true, count }
    }
    case 'RESTORE_ALL_CLOSED_TABS': {
      const windowId = (payload as { windowId?: number })?.windowId
      const count = await restoreAllClosedTabs(windowId)
      return { ok: true, count }
    }
    case 'DELETE_CLOSED_TAB': {
      const id = (payload as { id?: string })?.id
      if (id) await removeClosedTab(id)
      return { ok: true }
    }
    case 'DELETE_CLOSED_BATCH': {
      const batchId = (payload as { batchId?: string })?.batchId
      if (batchId) await removeClosedBatch(batchId)
      return { ok: true }
    }
    case 'CLEAR_CLOSED_TABS': {
      await clearClosedTabs()
      return { ok: true }
    }
    default:
      return null
  }
}

/**
 * Handles extension settings and MCP messages.
 */
async function handleSettingsAndMCPMessages(action: string, payload: unknown): Promise<unknown> {
  switch (action) {
    case 'GET_SETTINGS': {
      const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
      const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
      return { 
        ...DEFAULT_SETTINGS, 
        ...saved,
        ai: { 
          ...DEFAULT_SETTINGS.ai, 
          ...saved?.ai,
          providerSettings: {
            ...DEFAULT_SETTINGS.ai.providerSettings,
            ...saved?.ai?.providerSettings,
          },
        },
      }
    }
    case 'SAVE_SETTINGS': {
      const newSettings = payload as ExtensionSettings
      await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: newSettings })
      invalidatePreviewCache()
      await chrome.action.setPopup({ popup: newSettings.useSearchPopup ? 'src/popup/search.html' : 'src/popup/index.html' })
      return { ok: true }
    }
    case 'GET_MCP_STATUS':
      return getMCPStatus()
    case 'RECONNECT_MCP':
      reconnectMCP()
      return { ok: true }
    default:
      return null
  }
}

/**
 * Dispatches extension messages to domain-specific handlers.
 * @param {ExtensionMessage} message - Incoming message.
 * @param {chrome.runtime.MessageSender} [sender] - Message sender.
 * @returns {Promise<unknown>} Response payload.
 */
export async function handleExtensionMessage(message: ExtensionMessage, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender?.tab?.id && sender?.tab?.windowId) {
    registerOperationTab(sender.tab.windowId, sender.tab.id)
  }

  const logResult = await handleAILogMessages(message.action, message.payload)
  if (logResult !== null) return logResult

  const closedTabsResult = await handleClosedTabMessages(message.action, message.payload)
  if (closedTabsResult !== null) return closedTabsResult

  const settingsResult = await handleSettingsAndMCPMessages(message.action, message.payload)
  if (settingsResult !== null) return settingsResult

  switch (message.action) {
    case 'EXTEND_OPERATION': {
      const windowId = await resolveWindowId(message.payload)
      const extended = extendOperationTimeout(windowId)
      return { ok: extended }
    }

    case 'CANCEL_OPERATION': {
      const windowId = await resolveWindowId(message.payload)
      const applyCompleted = Boolean((message.payload as { applyCompleted?: boolean } | undefined)?.applyCompleted)
      cancelActiveOperation(windowId, applyCompleted)
      return { ok: true }
    }

    case 'STOP_AND_APPLY_OPERATION': {
      const windowId = await resolveWindowId(message.payload)
      cancelActiveOperation(windowId, true)
      return { ok: true }
    }

    case 'CLEAR_OPERATION_ERROR': {
      const windowId = (message.payload as { windowId: number })?.windowId
      if (windowId) clearOperationError(windowId)
      return { ok: true }
    }

    case 'GET_ACTIVE_OPERATIONS': {
      return getActiveOperations()
    }

    // AI Operations
    case 'GROUP_TABS': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', 'group', () => groupAllTabs(windowId, getAIOverrides(message.payload)))
    }

    case 'GROUP_TABS_SINGLE': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', null, () => groupAllTabs(windowId, { batchSize: 9999 }))
    }

    case 'GROUP_TABS_GEMINI_FLASH': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', null, () => groupAllTabs(windowId, { provider: 'gemini', model: 'gemini-3.5-flash' }))
    }

    case 'GROUP_TABS_GEMINI_2_5_FLASH': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', null, () => groupAllTabs(windowId, { provider: 'gemini', model: 'gemini-2.5-flash' }))
    }

    case 'GROUP_TABS_GPT_MINI': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', null, () => groupAllTabs(windowId, { provider: 'openai', model: 'gpt-4o-mini' }))
    }

    case 'GROUP_TABS_GPT_4O': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', null, () => groupAllTabs(windowId, { provider: 'openai', model: 'gpt-4o' }))
    }

    case 'GROUP_TABS_CLAUDE_SONNET': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'GROUP_TABS', null, () => groupAllTabs(windowId, { provider: 'claude', model: 'claude-3-5-sonnet-20240620' }))
    }

    case 'CLASSIFY_NEW_TABS': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'CLASSIFY_NEW_TABS', 'classify', () => classifyNewTabs(windowId, getAIOverrides(message.payload)))
    }

    case 'CLASSIFY_NEW_TABS_GEMINI': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'CLASSIFY_NEW_TABS', null, () => classifyNewTabs(windowId, { provider: 'gemini', model: 'gemini-3.5-flash' }))
    }

    case 'CLASSIFY_NEW_TABS_GPT': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'CLASSIFY_NEW_TABS', null, () => classifyNewTabs(windowId, { provider: 'openai', model: 'gpt-4o-mini' }))
    }

    case 'CHECK_LAST_20_TABS': {
      const windowId = await resolveWindowId(message.payload)
      return runAIOperation(windowId, 'CHECK_LAST_20_TABS', 'regroup', () => checkAndRegroupLast20Tabs(windowId, getAIOverrides(message.payload)))
    }

    case 'SPLIT_GROUP': {
      const groupId = (message.payload as { groupId: number })?.groupId
      if (!groupId) return { error: 'Missing groupId' }
      const group = await chrome.tabGroups.get(groupId)
      return runAIOperation(group.windowId, 'SPLIT_CURRENT_GROUP', null, () => splitGroup(groupId, getAIOverrides(message.payload)))
    }

    case 'MERGE_GROUP': {
      const groupId = (message.payload as { groupId: number })?.groupId
      if (!groupId) return { error: 'Missing groupId' }
      const group = await chrome.tabGroups.get(groupId)
      return runAIOperation(group.windowId, 'MERGE_CURRENT_GROUP', null, () => mergeGroup(groupId, getAIOverrides(message.payload)))
    }

    case 'SPLIT_CURRENT_GROUP': {
      const windowId = await resolveWindowId(message.payload)
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      if (activeTab?.groupId !== undefined && activeTab.groupId !== TAB_GROUP_ID_NONE) {
        return runAIOperation(windowId, 'SPLIT_CURRENT_GROUP', null, () => splitGroup(activeTab.groupId, getAIOverrides(message.payload)))
      }
      return { error: 'Active tab is not in a group' }
    }

    case 'MERGE_CURRENT_GROUP': {
      const windowId = await resolveWindowId(message.payload)
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      if (activeTab?.groupId !== undefined && activeTab.groupId !== TAB_GROUP_ID_NONE) {
        return runAIOperation(windowId, 'MERGE_CURRENT_GROUP', null, () => mergeGroup(activeTab.groupId, getAIOverrides(message.payload)))
      }
      return { error: 'Active tab is not in a group' }
    }

    // Tab Actions & Group Operations
    case 'BACKUP_GROUPS': {
      const windowId = await resolveWindowId(message.payload)
      const groups = await chrome.tabGroups.query({ windowId })
      const backupData = await Promise.all(groups.map(async (g) => {
        const tabs = await chrome.tabs.query({ groupId: g.id })
        return {
          title: g.title,
          color: g.color,
          collapsed: g.collapsed,
          tabs: tabs.map(t => ({ url: t.url, title: t.title }))
        }
      }))
      return { ok: true, backupData }
    }

    case 'UNGROUP_ALL': {
      const windowId = await resolveWindowId(message.payload)
      await ungroupAllTabs(windowId)
      invalidatePreviewCache(windowId)
      return { ok: true }
    }

    case 'CLEANUP_GROUPS': {
      const windowId = await resolveWindowId(message.payload)
      const minTabs = (message.payload as { minTabs?: number })?.minTabs ?? 3
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

    case 'CLOSE_DUPLICATES': {
      const payloadObj = message.payload && typeof message.payload === 'object' ? message.payload as Record<string, any> : null
      const explicitTabIds = Array.isArray(payloadObj?.tabIds) ? payloadObj.tabIds : undefined
      const windowId = await resolveWindowId(message.payload)
      await closeDuplicateTabs(windowId, explicitTabIds)
      return { ok: true }
    }

    case 'CLOSE_POSSIBLE_DUPLICATES': {
      const payloadObj = message.payload && typeof message.payload === 'object' ? message.payload as Record<string, any> : null
      const explicitTabIds = Array.isArray(payloadObj?.tabIds) ? payloadObj.tabIds : undefined
      const windowId = await resolveWindowId(message.payload)
      await closePossibleDuplicateTabs(windowId, explicitTabIds)
      return { ok: true }
    }

    case 'ORGANIZE_POSSIBLE_DUPLICATES': {
      const windowId = await resolveWindowId(message.payload)
      await organizePossibleDuplicateGroups(windowId)
      return { ok: true }
    }

    case 'RENAME_DUPLICATE_GROUPS': {
      const windowId = await resolveWindowId(message.payload)
      const payload = message.payload as {
        groups?: Array<{ id: number; name: string; windowId?: number }>
        clusters?: Array<{ normalized: string; groups: Array<{ id: number; name: string; windowId?: number }> }>
        windowId?: number
      } | undefined
      return runAIOperation(windowId, 'RENAME_DUPLICATE_GROUPS', 'rename', () =>
        renameDuplicateGroups(payload?.clusters || payload?.groups, windowId, getAIOverrides(message.payload))
      )
    }

    case 'GENERATE_WINDOW_NAME': {
      const windowId = await resolveWindowId(message.payload, sender)
      return runAIOperation(windowId, 'GENERATE_WINDOW_NAME', 'name_window', () =>
        generateWindowName(windowId, getAIOverrides(message.payload))
      )
    }

    case 'GENERATE_ALL_WINDOW_NAMES': {
      const windowId = await resolveWindowId(message.payload, sender)
      return runAIOperation(windowId, 'GENERATE_ALL_WINDOW_NAMES', 'name_window', () =>
        generateAllWindowsNames(getAIOverrides(message.payload))
      )
    }

    case 'GROUP_CLUSTER': {
      const { tabIds, title } = (message.payload as { tabIds: number[]; title: string }) || {}
      if (Array.isArray(tabIds) && tabIds.length > 0) {
        let targetGroupId: number | undefined

        if (title && typeof chrome.tabGroups !== 'undefined') {
          const allGroups = await chrome.tabGroups.query({ title })
          if (allGroups.length > 0) {
            const currentWindowId = sender?.tab?.windowId || chrome.windows.WINDOW_ID_CURRENT
            const existingGroup = allGroups.find(g => g.windowId === currentWindowId) || allGroups[0]
            targetGroupId = existingGroup.id
          }
        }

        try {
          const allTabs = await chrome.tabs.query({})
          const firstTab = allTabs.find(t => t.id === tabIds[0])
          if (firstTab && firstTab.windowId) {
            for (const tid of tabIds.slice(1)) {
              const t = allTabs.find(x => x.id === tid)
              if (t && t.windowId !== firstTab.windowId) {
                await chrome.tabs.move(tid, { windowId: firstTab.windowId, index: -1 })
              }
            }
          }

          const groupOptions: chrome.tabs.GroupOptions = { tabIds: tabIds as [number, ...number[]] }
          if (targetGroupId !== undefined) {
            groupOptions.groupId = targetGroupId
          }

          const groupId = await chrome.tabs.group(groupOptions)
          if (targetGroupId === undefined && title && typeof chrome.tabGroups !== 'undefined') {
            await chrome.tabGroups.update(groupId, { title, color: 'orange' })
          }
        } catch (e) {
          console.error('[timTabTool] Failed to group cluster:', e)
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
      const payload = message.payload as { query: string; windowId?: number; includeClosedWhenEmpty?: boolean } | undefined
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
      return searchTabs(query, openTabs, history, currentWindowId, payload?.includeClosedWhenEmpty)
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
        markTabIdsClosedByExtension([tabId])
        await recordTabIdsBeforeClose([tabId], 'Single Tab')
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

    case 'GET_SEARCH_OVERLAY_METRICS': {
      const windowId = await resolveWindowId(message.payload, sender)
      const tabs = await chrome.tabs.query({ windowId })
      const unpinnedTabsCount = tabs.filter(t => !t.pinned).length
      
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      let currentGroupTabsCount = 0
      if (activeTab?.groupId !== undefined && typeof chrome.tabGroups !== 'undefined' && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        currentGroupTabsCount = tabs.filter(t => t.groupId === activeTab.groupId).length
      }

      let newTabsCount = 0
      if (typeof chrome.tabGroups !== 'undefined') {
        newTabsCount = tabs.filter(t => {
          if (t.id === undefined || t.pinned) return false
          return t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE
        }).length
      } else {
        newTabsCount = unpinnedTabsCount
      }

      const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
      const saved = (data[STORAGE_KEYS.SETTINGS] ?? {}) as Partial<ExtensionSettings>
      const aiSettings = { 
        ...DEFAULT_SETTINGS.ai, 
        ...saved?.ai,
      }

      const activeOps = getActiveOperations()
      const activeOperation = activeOps[windowId] || null

      return {
        windowId,
        unpinnedTabsCount,
        currentGroupTabsCount,
        newTabsCount,
        aiSettings,
        activeOperation,
        activeOperations: activeOps,
      }
    }

    case 'TOGGLE_SEARCH_OVERLAY': {
      const payload = message.payload as { initialQuery?: string } | undefined
      await toggleSearchOverlay(payload?.initialQuery || '')
      return { ok: true }
    }

    case 'OPEN_CHAT_WINDOW': {
      const windowId = await resolveWindowId(message.payload, sender)
      if (!(await focusExistingChatTabOrWindow())) {
        await openChatInNewWindow(windowId > 0 ? windowId : undefined)
      }
      return { ok: true }
    }

    case 'OPEN_CHAT_TAB': {
      const windowId = await resolveWindowId(message.payload, sender)
      if (!(await focusExistingChatTabOrWindow())) {
        await openChatInNewTab(windowId > 0 ? windowId : undefined)
      }
      return { ok: true }
    }

    default:
      return { error: 'Unknown action' }
  }
}
