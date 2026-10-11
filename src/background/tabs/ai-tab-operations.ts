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
  isRestrictedUrl,
} from './tab-common'
import { ungroupAllTabs } from './tab-actions'
import {
  tabCreatedTimesMap,
  previewCacheMap,
  cacheIsAIGroupedMap,
  invalidatePreviewCache,
  chromeTabToTabInfo,
  getGroupsPreview,
} from '../cache/tab-cache'
import {
  activeAbortControllers,
  activeOperationsMap,
  activeAIOperationWindows,
  operationStartTimestamps,
  applyCompletedOnCancelFlags,
  setupOperationTimeout,
  clearOperationTimeout,
  registerTimeoutLogger,
  unregisterOperationTab,
  updateOperationProgress,
} from '../operations/operation-registry'
import {
  setAIBadge,
  updateNewTabsBadge,
  debouncedUpdateNewTabsBadge,
} from '../operations/badge-service'
import { classifyTabs } from '../classifier'
import { AIClient, SYSTEM_PROMPT } from '../../shared/ai-client'
import { AILogger } from '../../shared/ai-logger'
import {
  GROUP_DEFINITIONS,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_MODELS,
} from '../../shared/constants'
import { getMessage } from '../../shared/i18n'
import type {
  ExtensionSettings,
  ChromeTabGroupColor,
  GroupCategory,
  LastAIResult,
  OperationStatusInfo,
  AIProgressUpdate,
  RegroupLast20Result,
  ReviewAndRegroupDecision,
  ReviewAndRegroupTabInput,
  TabInfo,
  DuplicateGroupClusterItem,
  DistinctGroupRenameResult,
  WindowNameResult,
} from '../../shared/types'

export function cancelActiveOperation(windowId: number, applyCompleted = false): void {
  activeAIOperationWindows.delete(windowId)
  if (applyCompleted) {
    applyCompletedOnCancelFlags.set(windowId, true)
  }
  const controller = activeAbortControllers.get(windowId)
  if (controller) {
    controller.abort()
    activeAbortControllers.delete(windowId)
  }
  if (!applyCompleted) {
    activeOperationsMap.delete(windowId)
  }
  updateNewTabsBadge(windowId).catch(console.error)
}

export async function autoGroupNewTab(tab: chrome.tabs.Tab): Promise<void> {
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
    (t) => !t.pinned && (t.groupId === undefined || t.groupId === TAB_GROUP_ID_NONE),
  )

  if (ungroupedTabs.length > 1) {
    const sorted = sortTabsByDomainAndTitleHelper(ungroupedTabs)
    const tabIds = sorted.map((t) => t.id).filter((id): id is number => id !== undefined)
    await retryTabOperation(() => chrome.tabs.move(tabIds, { index: -1 }))
  }

  debouncedUpdateNewTabsBadge(windowId)
}

function getLast20UnpinnedTabs(tabs: chrome.tabs.Tab[]): chrome.tabs.Tab[] {
  const unpinned = tabs
    .filter((t) => !t.pinned && t.id !== undefined)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return unpinned.slice(-20)
}

function buildExistingGroupsMap(allGroups: chrome.tabGroups.TabGroup[]): {
  groupNameToId: Map<string, number>
  groupIdToName: Map<number, string>
  existingGroupNames: string[]
} {
  const groupNameToId = new Map<string, number>()
  const groupIdToName = new Map<number, string>()
  for (const g of allGroups) {
    const rawName = groupTitleMap.get(g.id) || g.title
    const name = (rawName && rawName.trim().length > 0) ? rawName.trim() : `Group ${g.id}`
    groupNameToId.set(name, g.id)
    groupIdToName.set(g.id, name)
  }
  return {
    groupNameToId,
    groupIdToName,
    existingGroupNames: [...groupNameToId.keys()],
  }
}

interface RegroupPlan {
  existingGroupUpdates: Map<number, number[]>
  newGroupUpdates: Map<string, { tabIds: number[]; color: ChromeTabGroupColor }>
  tabsToUngroup: number[]
  unchangedCount: number
  regroupedCount: number
}

function addTabToExistingGroup(
  tabId: number,
  targetGid: number,
  currentGid: number | undefined,
  plan: RegroupPlan
): void {
  if (currentGid === targetGid) {
    plan.unchangedCount++
  } else {
    if (!plan.existingGroupUpdates.has(targetGid)) plan.existingGroupUpdates.set(targetGid, [])
    plan.existingGroupUpdates.get(targetGid)!.push(tabId)
    plan.regroupedCount++
  }
}

function addTabToNewGroup(
  tabId: number,
  newName: string,
  color: ChromeTabGroupColor,
  currentName: string,
  plan: RegroupPlan
): void {
  if (currentName && currentName.toLowerCase() === newName.toLowerCase()) {
    plan.unchangedCount++
  } else {
    if (!plan.newGroupUpdates.has(newName)) plan.newGroupUpdates.set(newName, { tabIds: [], color })
    plan.newGroupUpdates.get(newName)!.tabIds.push(tabId)
    plan.regroupedCount++
  }
}

function findGroupIdByName(name: string | undefined, groupNameToId: Map<string, number>): number | undefined {
  if (!name) return undefined
  const exact = groupNameToId.get(name)
  if (exact !== undefined) return exact
  const lower = name.toLowerCase()
  for (const [key, id] of groupNameToId) {
    if (key.toLowerCase() === lower) return id
  }
  return undefined
}

function categorizeTabDecision(
  tab: chrome.tabs.Tab,
  decision: ReviewAndRegroupDecision,
  groupNameToId: Map<string, number>,
  groupIdToName: Map<number, string>,
  plan: RegroupPlan
): void {
  const currentGid = tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE ? tab.groupId : undefined
  const currentName = currentGid !== undefined ? (groupIdToName.get(currentGid) || '') : ''

  if (decision.group === 'KEEP') {
    plan.unchangedCount++
    return
  }
  if (decision.group === '_ungrouped_' || decision.group === 'UNGROUPED') {
    if (currentGid !== undefined) {
      plan.tabsToUngroup.push(tab.id!)
      plan.regroupedCount++
    } else {
      plan.unchangedCount++
    }
    return
  }

  const targetGid = findGroupIdByName(decision.group, groupNameToId) ?? findGroupIdByName(decision.newGroupName, groupNameToId)
  if (targetGid !== undefined) {
    addTabToExistingGroup(tab.id!, targetGid, currentGid, plan)
    return
  }

  const newName = decision.newGroupName || decision.group || 'New Group'
  const color = (decision.newGroupColor as ChromeTabGroupColor) || 'grey'
  addTabToNewGroup(tab.id!, newName, color, currentName, plan)
}

function buildRegroupPlan(
  targetTabs: chrome.tabs.Tab[],
  decisions: ReviewAndRegroupDecision[],
  groupNameToId: Map<string, number>,
  groupIdToName: Map<number, string>
): RegroupPlan {
  const plan: RegroupPlan = {
    existingGroupUpdates: new Map<number, number[]>(),
    newGroupUpdates: new Map<string, { tabIds: number[]; color: ChromeTabGroupColor }>(),
    tabsToUngroup: [],
    unchangedCount: 0,
    regroupedCount: 0,
  }

  const decisionsByTab = new Map<number, ReviewAndRegroupDecision>()
  for (const d of decisions) {
    decisionsByTab.set(d.index, d)
  }

  for (let idx = 0; idx < targetTabs.length; idx++) {
    const tab = targetTabs[idx]
    if (!tab?.id) continue
    const decision = decisionsByTab.get(idx) || { index: idx, group: 'KEEP' }
    categorizeTabDecision(tab, decision, groupNameToId, groupIdToName, plan)
  }

  return plan
}

async function applyExistingGroupMoves(
  existingGroupUpdates: Map<number, number[]>,
  currentTabIdsSet: Set<number>,
  signal?: AbortSignal
): Promise<void> {
  for (const [groupId, tabIds] of existingGroupUpdates) {
    if (signal?.aborted) return
    const valid = tabIds.filter((id) => currentTabIdsSet.has(id))
    if (valid.length === 0) continue

    const groupTabs = await chrome.tabs.query({ groupId })
    if (groupTabs.length > 0) {
      groupTabs.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const targetIndex = (groupTabs[groupTabs.length - 1].index ?? 0) + 1
      await retryTabOperation(() =>
        chrome.tabs.move(valid, { index: targetIndex })
      )
    }
    await retryTabOperation(() => chrome.tabs.group({ tabIds: valid as [number, ...number[]], groupId }))
  }
}

async function applyNewGroupCreations(
  newGroupUpdates: Map<string, { tabIds: number[]; color: ChromeTabGroupColor }>,
  currentTabIdsSet: Set<number>,
  windowId: number,
  hideTitles: boolean,
  signal?: AbortSignal
): Promise<string[]> {
  const createdNames: string[] = []
  for (const [name, { tabIds, color }] of newGroupUpdates) {
    if (signal?.aborted) return createdNames
    const valid = tabIds.filter((id) => currentTabIdsSet.has(id))
    if (valid.length === 0) continue

    const newGid = await retryTabOperation(() =>
      chrome.tabs.group({
        tabIds: valid as [number, ...number[]],
        createProperties: { windowId },
      })
    )
    if (newGid !== undefined) {
      groupTitleMap.set(newGid, name)
      createdNames.push(name)
      await retryTabOperation(() =>
        chrome.tabGroups.update(newGid, {
          title: hideTitles ? '' : name,
          color: color || 'grey',
        })
      )
    }
  }
  return createdNames
}

async function applyUngroupMoves(
  tabsToUngroup: number[],
  currentTabIdsSet: Set<number>,
  signal?: AbortSignal
): Promise<void> {
  if (tabsToUngroup.length === 0 || signal?.aborted) return
  const valid = tabsToUngroup.filter((id) => currentTabIdsSet.has(id))
  if (valid.length > 0) {
    await retryTabOperation(() => chrome.tabs.ungroup(valid as [number, ...number[]]))
  }
}

async function applyRegroupPlan(
  plan: RegroupPlan,
  windowId: number,
  hideTitles: boolean,
  signal?: AbortSignal
): Promise<string[]> {
  const currentTabs = await chrome.tabs.query({ windowId })
  const currentTabIdsSet = new Set(currentTabs.map((t) => t.id).filter((id): id is number => id !== undefined))

  await applyExistingGroupMoves(plan.existingGroupUpdates, currentTabIdsSet, signal)
  const createdNames = await applyNewGroupCreations(plan.newGroupUpdates, currentTabIdsSet, windowId, hideTitles, signal)
  await applyUngroupMoves(plan.tabsToUngroup, currentTabIdsSet, signal)

  return createdNames
}

async function recordRegroupCompleted(
  windowId: number,
  targetTabsCount: number,
  groupsBefore: number,
  createdNames: string[],
  summary: string,
  logger?: AILogger,
  capturedReasoning?: string
): Promise<void> {
  const finalGroups = isTabGroupsSupported() ? await chrome.tabGroups.query({ windowId }) : []
  if (logger) {
    await logger.markCompleted({
      createdGroupsCount: createdNames.length,
      createdGroupNames: createdNames,
      groupsBefore,
      groupsAfter: finalGroups.length,
      summary,
    })
  }

  const lastResult: LastAIResult = {
    timestamp: Date.now(),
    actionType: 'regroup',
    actionTitle: 'Check & Regroup Last 20 Tabs',
    windowId,
    tabsProcessed: targetTabsCount,
    groupsBefore,
    groupsAfter: finalGroups.length,
    createdGroupNames: createdNames,
    summary,
    reasoning: capturedReasoning || undefined,
    reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
  chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
}

function initRegroupOperation(windowId: number): AbortController {
  const existing = activeAbortControllers.get(windowId)
  if (existing) existing.abort()

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'regroup', error: null })
  activeAIOperationWindows.add(windowId)
  return controller
}

async function resolveAISettings(aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<ExtensionSettings> {
  let settings = await getSettings()
  if (aiOverrides) {
    settings = {
      ...settings,
      ai: { ...settings.ai, ...aiOverrides },
    }
  }
  if (!settings.ai.enabled || !settings.ai.apiKey) {
    throw new Error('AI is not configured. Please enable AI and set an API key in Settings.')
  }
  return settings
}

async function finishEmptyRegroup(windowId: number, logger?: AILogger): Promise<RegroupLast20Result> {
  activeOperationsMap.delete(windowId)
  operationStartTimestamps.delete(windowId)
  const summary = 'No unpinned tabs found to check.'
  if (logger) {
    await logger.markCompleted({
      createdGroupsCount: 0,
      createdGroupNames: [],
      groupsBefore: 0,
      groupsAfter: 0,
      summary,
    })
  }
  const lastResult: LastAIResult = {
    timestamp: Date.now(),
    actionType: 'regroup',
    actionTitle: 'Check & Regroup Last 20 Tabs',
    windowId,
    tabsProcessed: 0,
    groupsBefore: 0,
    groupsAfter: 0,
    createdGroupNames: [],
    summary,
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
  chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
  return { checkedCount: 0, regroupedCount: 0, unchangedCount: 0, summary }
}

async function initRegroupLogger(
  windowId: number,
  aiConfig: ExtensionSettings['ai'],
  targetTabs: chrome.tabs.Tab[],
  existingGroupNames: string[],
  aiOverrides?: Partial<ExtensionSettings['ai']>
): Promise<AILogger | undefined> {
  const alwaysLog = aiConfig.alwaysLogAIOperations ?? true
  const isShift = Boolean(aiOverrides && ((aiOverrides as any).shiftKey || (aiOverrides as any).verboseLog))
  if (!alwaysLog && !isShift) return undefined

  const logger = await AILogger.create({
    actionType: 'CHECK_LAST_20_TABS',
    triggeredWithShift: isShift,
    config: aiConfig,
    tabsInput: targetTabs.map((t, idx) => ({ index: idx + 1, title: t.title || '', url: t.url, groupId: t.groupId })),
    prompts: {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: 'Check if the last 20 tabs are in correct groups, and regroup them if needed.',
    },
    windowId,
  })
  const est = AIClient.estimateCostAndTokens(aiConfig, targetTabs.length, 'regroup', undefined, undefined, existingGroupNames)
  logger.recordTokenEstimate(est.tokens, 0, est.costStr)
  registerTimeoutLogger(windowId, logger)
  return logger
}

async function queryAIDecisions(
  windowId: number,
  aiConfig: ExtensionSettings['ai'],
  targetTabs: chrome.tabs.Tab[],
  groupIdToName: Map<number, string>,
  existingGroupNames: string[],
  controller: AbortController,
  logger?: AILogger,
  onReasoningCapture?: (reasoning: string) => void
): Promise<ReviewAndRegroupDecision[]> {
  await setAIBadge(windowId)
  operationStartTimestamps.set(windowId, Date.now())
  const modelName = aiConfig.model || DEFAULT_MODELS[aiConfig.provider] || 'default'

  updateOperationProgress(windowId, {
    type: 'regroup',
    error: null,
    stage: 'preparing',
    statusText: `Checking ${targetTabs.length} tab${targetTabs.length === 1 ? '' : 's'} for correct group assignment...`,
    totalTabs: targetTabs.length,
    processedTabs: 0,
    model: modelName,
    provider: aiConfig.provider,
  })

  const client = new AIClient(aiConfig, controller.signal, logger)
  const tabInputs: ReviewAndRegroupTabInput[] = targetTabs.map((t) => ({
    url: t.url || '',
    title: t.title || '',
    currentGroup: t.groupId !== undefined && t.groupId !== TAB_GROUP_ID_NONE ? (groupIdToName.get(t.groupId) || '') : undefined,
    lastAccessed: t.lastAccessed,
    createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
  }))

  return client.reviewAndRegroupTabs(tabInputs, existingGroupNames, false, (update: AIProgressUpdate) => {
    if (update.liveReasoning) {
      onReasoningCapture?.(update.liveReasoning)
    } else if (update.reasoningSnippet && !onReasoningCapture) {
      // noop
    }
    updateOperationProgress(windowId, update)
  })
}

async function executeRegroupDecisions(
  windowId: number,
  targetTabs: chrome.tabs.Tab[],
  decisions: ReviewAndRegroupDecision[],
  groupNameToId: Map<string, number>,
  groupIdToName: Map<number, string>,
  groupsBefore: number,
  controller: AbortController,
  logger?: AILogger,
  capturedReasoning?: string
): Promise<RegroupLast20Result> {
  const plan = buildRegroupPlan(targetTabs, decisions, groupNameToId, groupIdToName)
  const hideTitles = titlesHiddenMap.get(windowId) ?? false

  let createdNames: string[] = []
  if (plan.regroupedCount > 0) {
    updateOperationProgress(windowId, {
      stage: 'applying',
      statusText: `Regrouping ${plan.regroupedCount} tab${plan.regroupedCount === 1 ? '' : 's'}...`,
      totalTabs: targetTabs.length,
      processedTabs: plan.unchangedCount,
    })
    createdNames = await applyRegroupPlan(plan, windowId, hideTitles, controller.signal)
    invalidatePreviewCache(windowId)
    await updateNewTabsBadge(windowId)
  }

  const summary = plan.regroupedCount > 0
    ? `Checked ${targetTabs.length} tabs: regrouped ${plan.regroupedCount} (${plan.unchangedCount} already correct)`
    : `Checked ${targetTabs.length} tabs: all tabs are already in correct groups`

  await recordRegroupCompleted(windowId, targetTabs.length, groupsBefore, createdNames, summary, logger, capturedReasoning)
  return { checkedCount: targetTabs.length, regroupedCount: plan.regroupedCount, unchangedCount: plan.unchangedCount, summary }
}

function cleanupRegroupOperation(windowId: number, controller: AbortController): void {
  activeAIOperationWindows.delete(windowId)
  clearOperationTimeout(windowId)
  unregisterOperationTab(windowId)
  if (activeAbortControllers.get(windowId) === controller) {
    activeAbortControllers.delete(windowId)
  }
  if (activeOperationsMap.get(windowId)?.type === 'regroup') {
    activeOperationsMap.delete(windowId)
  }
  operationStartTimestamps.delete(windowId)
}

export async function checkAndRegroupLast20Tabs(
  windowId: number,
  aiOverrides?: Partial<ExtensionSettings['ai']>
): Promise<RegroupLast20Result> {
  if (!isTabGroupsSupported()) {
    throw new Error('Tab grouping is not supported in this browser.')
  }
  const controller = initRegroupOperation(windowId)
  let logger: AILogger | undefined

  try {
    const settings = await resolveAISettings(aiOverrides)
    const allTabs = await chrome.tabs.query({ windowId })
    const allGroups = await chrome.tabGroups.query({ windowId })
    const targetTabs = getLast20UnpinnedTabs(allTabs)

    const { groupNameToId, groupIdToName, existingGroupNames } = buildExistingGroupsMap(allGroups)
    logger = await initRegroupLogger(windowId, settings.ai, targetTabs, existingGroupNames, aiOverrides)

    if (targetTabs.length === 0) {
      return await finishEmptyRegroup(windowId, logger)
    }

    let capturedReasoning = ''
    const decisions = await queryAIDecisions(
      windowId,
      settings.ai,
      targetTabs,
      groupIdToName,
      existingGroupNames,
      controller,
      logger,
      (reasoning) => {
        capturedReasoning = reasoning
      }
    )
    if (controller.signal.aborted) {
      if (logger) {
        await logger.markFailed(new Error('Operation aborted by user.'))
      }
      return { checkedCount: targetTabs.length, regroupedCount: 0, unchangedCount: targetTabs.length, summary: 'Check canceled by user.' }
    }

    return await executeRegroupDecisions(
      windowId,
      targetTabs,
      decisions,
      groupNameToId,
      groupIdToName,
      allGroups.length,
      controller,
      logger,
      capturedReasoning
    )
  } catch (err: any) {
    if (logger && !controller.signal.aborted) {
      await logger.markFailed(err)
    }
    const errMsg = err?.message || String(err)
    updateOperationProgress(windowId, {
      stage: 'failed',
      statusText: `Failed: ${errMsg}`,
      error: errMsg,
    })
    throw err
  } finally {
    cleanupRegroupOperation(windowId, controller)
  }
}

export async function groupAllTabs(windowId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
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
        },
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
          },
          windowId,
        })
        const est = AIClient.estimateCostAndTokens(settings.ai, unpinnedTabs.length, 'group')
        logger.recordTokenEstimate(est.tokens, 0, est.costStr)
        registerTimeoutLogger(windowId, logger)
      }

      try {
        await setAIBadge(windowId)
        operationStartTimestamps.set(windowId, Date.now())
        const modelName = settings.ai.model || DEFAULT_MODELS[settings.ai.provider] || 'default'
        const est = AIClient.estimateCostAndTokens(settings.ai, unpinnedTabs.length, 'group')

        updateOperationProgress(windowId, {
          type: 'group',
          error: null,
          stage: 'preparing',
          statusText: `Organizing ${unpinnedTabs.length} tab${unpinnedTabs.length === 1 ? '' : 's'} with AI...`,
          totalTabs: unpinnedTabs.length,
          processedTabs: 0,
          model: modelName,
          provider: settings.ai.provider,
          tokenEstimate: { tokens: est.tokens, costStr: est.costStr },
        })

        const client = new AIClient(settings.ai, controller.signal, logger)
        const tabsWithTime = unpinnedTabs.map((t) => ({
          url: t.url || '',
          title: t.title || '',
          lastAccessed: t.lastAccessed,
          createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
        }))
        let capturedReasoning = ''
        const freeGroups = await client.groupTabsFreely(
          tabsWithTime,
          [],
          (update: Partial<OperationStatusInfo>) => {
            if (update.liveReasoning) {
              capturedReasoning = update.liveReasoning
            }
            updateOperationProgress(windowId, update)
          }
        )

        const shouldApplyPartial = Boolean(applyCompletedOnCancelFlags.get(windowId) && freeGroups.length > 0)
        applyCompletedOnCancelFlags.delete(windowId)

        if (controller.signal.aborted && !shouldApplyPartial) {
          if (logger) await logger.markFailed(new Error('Operation aborted'))
          return
        }

        if (freeGroups.length === 0) {
          activeOperationsMap.delete(windowId)
          operationStartTimestamps.delete(windowId)
          return
        }

        const isPartial = freeGroups.flatMap((g) => g.tabIndices).length < unpinnedTabs.length

        updateOperationProgress(windowId, {
          stage: 'applying',
          statusText: isPartial
            ? `Applying ${freeGroups.length} groups across tabs from completed batches...`
            : 'Applying tab groups to browser...',
          totalTabs: unpinnedTabs.length,
          processedTabs: 0,
        })

        await ungroupAllTabs(windowId)

        const groupTabMap = freeGroups.map((g) => {
          const tabIds: number[] = []
          for (const idx of g.tabIndices) {
            const tab = unpinnedTabs[idx - 1]
            if (tab && tab.id !== undefined) {
              tabIds.push(tab.id)
            }
          }
          return { name: g.name, color: g.color, tabIds }
        })

        const orderedTabIds: number[] = []
        for (const g of groupTabMap) {
          orderedTabIds.push(...g.tabIds)
        }

        const currentTabs = await chrome.tabs.query({ windowId })
        const pinnedCount = currentTabs.filter((t) => t.pinned).length

        if (orderedTabIds.length > 0) {
          await retryTabOperation(() => chrome.tabs.move(orderedTabIds, { index: pinnedCount }))
        }

        let appliedTabCount = 0
        for (let gi = 0; gi < groupTabMap.length; gi++) {
          if (controller.signal.aborted) return
          const group = groupTabMap[gi]
          if (group.tabIds.length === 0) continue
          if (group.name === '_ungrouped_') continue

          updateOperationProgress(windowId, {
            stage: 'applying',
            statusText: `Grouping tabs into "${group.name}" (${gi + 1}/${freeGroups.length})...`,
            processedTabs: appliedTabCount,
            totalTabs: unpinnedTabs.length,
          })

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
          appliedTabCount += group.tabIds.length
        }

        invalidatePreviewCache(windowId)
        await getGroupsPreview(windowId)
        debouncedUpdateNewTabsBadge(windowId)
        
        updateOperationProgress(windowId, {
          stage: 'completed',
          statusText: isPartial
            ? `Stopped. Applied ${freeGroups.length} groups across ${orderedTabIds.length} tabs.`
            : `Organized ${unpinnedTabs.length} tabs into ${freeGroups.length} groups`,
          processedTabs: unpinnedTabs.length,
          totalTabs: unpinnedTabs.length,
        })
        activeOperationsMap.delete(windowId)
        operationStartTimestamps.delete(windowId)

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
          reasoning: capturedReasoning || undefined,
          reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
        }
        await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
        chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
        return
      } catch (err) {
        if (logger) {
          await logger.markFailed(err)
        }
        if (controller.signal.aborted) {
          return
        }
        aiError = err as Error
        if (settings.ai.fallbackToSort) {
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
        const finalErr = new Error(`AI Grouping failed: ${aiError.message}`)
        activeOperationsMap.set(windowId, { type: null, error: finalErr.message })
        throw finalErr
      }
    }

    // Offline Rule Engine Grouping
    await ungroupAllTabs(windowId)
    if (controller.signal.aborted) return

    const groups = classifyTabs(unpinnedTabs)
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
      const groupId = await retryTabOperation(() =>
        chrome.tabs.group({
          tabIds: tabIds as [number, ...number[]],
          createProperties: { windowId },
        }),
      )
      if (groupId === undefined) continue
      const groupName = getMessage(def.labelKey)
      groupTitleMap.set(groupId, groupName)
      await retryTabOperation(() =>
        chrome.tabGroups.update(groupId, {
          title: hideTitles ? '' : groupName,
          color: def.color,
        }),
      )
    }

    invalidatePreviewCache(windowId)
    await getGroupsPreview(windowId)
    debouncedUpdateNewTabsBadge(windowId)
    activeOperationsMap.delete(windowId)
  } finally {
    activeAIOperationWindows.delete(windowId)
    clearOperationTimeout(windowId)
    unregisterOperationTab(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
  }
}

export async function classifyNewTabs(windowId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
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
        },
      }
    }
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured')
    }

    const allTabs = await chrome.tabs.query({ windowId })
    const allGroups = await chrome.tabGroups.query({ windowId })

    const newTabs = allTabs.filter((t) => {
      if (t.id === undefined || t.pinned) return false
      return t.groupId === TAB_GROUP_ID_NONE
    })
    if (newTabs.length === 0) return

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

    await setAIBadge(windowId)
    operationStartTimestamps.set(windowId, Date.now())
    const modelName = settings.ai.model || DEFAULT_MODELS[settings.ai.provider] || 'default'
    const est = AIClient.estimateCostAndTokens(settings.ai, newTabs.length, 'classify', undefined, undefined, existingGroupNames)

    updateOperationProgress(windowId, {
      type: 'classify',
      error: null,
      stage: 'preparing',
      statusText: `Classifying ${newTabs.length} new tab${newTabs.length === 1 ? '' : 's'} into groups...`,
      totalTabs: newTabs.length,
      processedTabs: 0,
      model: modelName,
      provider: settings.ai.provider,
      tokenEstimate: { tokens: est.tokens, costStr: est.costStr },
    })

    const client = new AIClient(settings.ai, controller.signal, logger)
    let classifications
    let capturedReasoning = ''
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
        (update: Partial<OperationStatusInfo>) => {
          if (update.liveReasoning) {
            capturedReasoning = update.liveReasoning
          }
          updateOperationProgress(windowId, update)
        }
      )
    } catch (classifyErr) {
      if (logger) await logger.markFailed(classifyErr)
      throw classifyErr
    }

    const shouldApplyPartial = Boolean(applyCompletedOnCancelFlags.get(windowId) && classifications && classifications.length > 0)
    applyCompletedOnCancelFlags.delete(windowId)

    if (controller.signal.aborted && !shouldApplyPartial) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return
    }

    if (!classifications || classifications.length === 0) {
      activeOperationsMap.delete(windowId)
      operationStartTimestamps.delete(windowId)
      return
    }

    const isPartial = classifications.length < newTabs.length

    updateOperationProgress(windowId, {
      stage: 'applying',
      statusText: isPartial 
        ? `Applying classifications across ${classifications.length} tabs from completed batches...`
        : 'Applying classifications to browser tabs...',
      totalTabs: newTabs.length,
      processedTabs: 0,
    })

    if (logger) {
      await logger.markCompleted({
        summary: `Classified ${newTabs.length} tabs into existing/new groups`,
      })
    }

    const hideTitles = titlesHiddenMap.get(windowId) ?? false

    const existingGroupUpdates = new Map<number, number[]>()
    const newGroupUpdates = new Map<string, { tabIds: number[], color: ChromeTabGroupColor }>()

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
        
        if (name === '_ungrouped_') continue
        
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

    const currentTabsForFilter = await chrome.tabs.query({ windowId })
    const currentTabIdsSet = new Set(currentTabsForFilter.map(t => t.id))

    for (const [groupId, tabIds] of existingGroupUpdates) {
      if (controller.signal.aborted) return
      const validTabIds = tabIds.filter(id => currentTabIdsSet.has(id))
      if (validTabIds.length === 0) continue
      
      const groupTabs = await chrome.tabs.query({ groupId })
      if (groupTabs.length > 0) {
        await retryTabOperation(() => chrome.tabs.move(validTabIds, { index: groupTabs[groupTabs.length - 1].index + 1 }))
      }
      
      await retryTabOperation(() => chrome.tabs.group({ tabIds: validTabIds as [number, ...number[]], groupId }))
    }

    const orderedNewTabIds = Array.from(newGroupUpdates.values())
      .flatMap(g => g.tabIds)
      .filter(id => currentTabIdsSet.has(id))
      
    if (orderedNewTabIds.length > 0) {
      const pinnedCount = currentTabsForFilter.filter((t) => t.pinned).length
      await retryTabOperation(() => chrome.tabs.move(orderedNewTabIds, { index: pinnedCount }))
    }

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

    const createdGroupTitles = Array.from(newGroupUpdates.keys())
    const summaryParts: string[] = []
    if (targetGroupTitles.length > 0) {
      summaryParts.push(`merged into ${targetGroupTitles.length} existing group${targetGroupTitles.length > 1 ? 's' : ''} (${targetGroupTitles.join(', ')})`)
    }
    if (createdGroupTitles.length > 0) {
      summaryParts.push(`created ${createdGroupTitles.length} new group${createdGroupTitles.length > 1 ? 's' : ''} (${createdGroupTitles.join(', ')})`)
    }
    const actionSummary = summaryParts.length > 0
      ? `Classified ${classifications.length} tabs: ${summaryParts.join(' and ')}`
      : `Classified ${classifications.length} tabs`

    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'classify',
      actionTitle: 'Classify New Tabs',
      windowId,
      tabsProcessed: classifications.length,
      groupsBefore: allGroups.length,
      groupsAfter,
      createdGroupNames: createdGroupTitles,
      summary: actionSummary,
      reasoning: capturedReasoning || undefined,
      reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
  } finally {
    activeAIOperationWindows.delete(windowId)
    clearOperationTimeout(windowId)
    unregisterOperationTab(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
  }
}

export async function splitGroup(groupId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
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
    await setAIBadge(windowId)

    const tabInputs = tabs.map((t) => ({
      url: t.url || '',
      title: t.title || '',
      lastAccessed: t.lastAccessed,
      createdAt: t.id !== undefined ? tabCreatedTimesMap.get(t.id) ?? t.lastAccessed : t.lastAccessed,
    }))
    
    const allGroups = await chrome.tabGroups.query({ windowId })
    const otherGroupNames = allGroups
      .filter((g) => g.id !== groupId)
      .map((g) => groupTitleMap.get(g.id) || g.title)
      .filter((title): title is string => Boolean(title?.trim()))

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
          customPrompt: settings.ai.customPrompt,
        },
        windowId,
      })
      registerTimeoutLogger(windowId, logger)
    }

    const splitConfig = {
      ...settings.ai,
      groupingPrompt: splitPrompt,
    }
    const client = new AIClient(splitConfig, controller.signal, logger)
    let capturedReasoning = ''
    const freeGroups = await client.groupTabsFreely(tabInputs, [], (update: Partial<OperationStatusInfo>) => {
      if (update.liveReasoning) {
        capturedReasoning = update.liveReasoning
      }
      updateOperationProgress(windowId, update)
    })

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return
    }

    if (freeGroups.length === 0) {
      throw new Error('AI could not determine meaningful sub-groups for this collection of tabs.')
    }

    const tabIdsToUngroup = tabs.map((t) => t.id).filter((id): id is number => id !== undefined)
    if (tabIdsToUngroup.length > 0) {
      await retryTabOperation(() => chrome.tabs.ungroup(tabIdsToUngroup as [number, ...number[]]))
    }

    const startIndex = Math.min(...tabs.map((t) => t.index))
    let currentIndex = startIndex

    for (const subGroup of freeGroups) {
      if (controller.signal.aborted) return
      const subGroupTabIds: number[] = []
      for (const idx of subGroup.tabIndices) {
        const t = tabs[idx - 1]
        if (t && t.id !== undefined) subGroupTabIds.push(t.id)
      }
      if (subGroupTabIds.length === 0) continue

      await retryTabOperation(() => chrome.tabs.move(subGroupTabIds, { index: currentIndex }))
      currentIndex += subGroupTabIds.length

      const newGid = await retryTabOperation(() =>
        chrome.tabs.group({
          tabIds: subGroupTabIds as [number, ...number[]],
          createProperties: { windowId },
        })
      )
      if (newGid === undefined) continue
      groupTitleMap.set(newGid, subGroup.name)
      await retryTabOperation(() =>
        chrome.tabGroups.update(newGid, {
          title: hideTitles ? '' : subGroup.name,
          color: subGroup.color,
        })
      )
    }

    invalidatePreviewCache(windowId)
    await getGroupsPreview(windowId)
    activeOperationsMap.delete(windowId)

    const finalWinGroups = await chrome.tabGroups.query({ windowId })
    const createdNames = freeGroups.map((g) => g.name)
    const summary = `Split group into ${createdNames.length} sub-groups: ${createdNames.join(', ')}`
    if (logger) {
      await logger.markCompleted({
        createdGroupsCount: createdNames.length,
        createdGroupNames: createdNames,
        groupsBefore: allGroups.length,
        groupsAfter: finalWinGroups.length,
        summary,
      })
    }
    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'split',
      actionTitle: 'Split Group',
      windowId,
      tabsProcessed: tabs.length,
      groupsBefore: allGroups.length,
      groupsAfter: finalWinGroups.length,
      createdGroupNames: createdNames,
      summary,
      reasoning: capturedReasoning || undefined,
      reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
  } finally {
    activeAIOperationWindows.delete(windowId)
    clearOperationTimeout(windowId)
    unregisterOperationTab(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'group') {
      activeOperationsMap.delete(windowId)
    }
    await updateNewTabsBadge(windowId).catch(console.error)
  }
}

export async function mergeGroup(groupId: number, aiOverrides?: Partial<ExtensionSettings['ai']>): Promise<void> {
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
  activeOperationsMap.set(windowId, { type: 'merge', error: null })
  operationStartTimestamps.set(windowId, Date.now())

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

    const allGroups = await chrome.tabGroups.query({ windowId })
    const otherGroups = allGroups.filter((g) => g.id !== groupId)

    if (otherGroups.length === 0) {
      throw new Error('No other groups in this window to merge into.')
    }

    const groupNameToId = new Map<string, number>()
    for (const g of otherGroups) {
      const name = groupTitleMap.get(g.id) || g.title
      if (name) groupNameToId.set(name, g.id)
    }

    const otherGroupNames = [...groupNameToId.keys()]
    if (otherGroupNames.length === 0) {
      throw new Error('No other named groups in this window to merge into.')
    }

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
          userPrompt: settings.ai.mergePrompt || 'Classify and merge these tabs into the most relevant existing group.',
          customPrompt: settings.ai.customPrompt,
        },
        windowId,
      })
      registerTimeoutLogger(windowId, logger)
    }

    const mergeConfig = {
      ...settings.ai,
      classifyPrompt: settings.ai.mergePrompt || 'Classify and merge these tabs into the most relevant existing group.',
    }
    const client = new AIClient(mergeConfig, controller.signal, logger)
    let capturedReasoning = ''
    const classifications = await client.classifyNewTabsIntoGroups(
      tabInputs,
      otherGroupNames,
      false,
      (update: Partial<OperationStatusInfo>) => {
        if (update.liveReasoning) {
          capturedReasoning = update.liveReasoning
        }
        updateOperationProgress(windowId, update)
      }
    )

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return
    }

    const targetGroupTabMap = new Map<number, number[]>()
    for (const item of classifications) {
      const tab = tabs[item.index]
      if (!tab?.id) continue
      const targetGid = groupNameToId.get(item.group)
      if (targetGid !== undefined) {
        if (!targetGroupTabMap.has(targetGid)) targetGroupTabMap.set(targetGid, [])
        targetGroupTabMap.get(targetGid)!.push(tab.id)
      }
    }

    for (const [targetGid, tabIds] of targetGroupTabMap) {
      if (controller.signal.aborted) return
      const targetTabs = await chrome.tabs.query({ groupId: targetGid })
      if (targetTabs.length > 0) {
        const destIndex = targetTabs[targetTabs.length - 1].index + 1
        await retryTabOperation(() => chrome.tabs.move(tabIds, { index: destIndex }))
      }
      await retryTabOperation(() => chrome.tabs.group({ tabIds: tabIds as [number, ...number[]], groupId: targetGid }))
    }

    invalidatePreviewCache(windowId)
    await getGroupsPreview(windowId)
    activeOperationsMap.delete(windowId)

    const mergedToNames: string[] = []
    for (const gid of targetGroupTabMap.keys()) {
      const name = groupTitleMap.get(gid) || otherGroups.find((g) => g.id === gid)?.title || `Group ${gid}`
      mergedToNames.push(name)
    }
    const summary = `Merged group into: ${mergedToNames.join(', ')}`
    if (logger) {
      await logger.markCompleted({
        createdGroupsCount: 0,
        createdGroupNames: [],
        groupsBefore: allGroups.length,
        groupsAfter: (await chrome.tabGroups.query({ windowId })).length,
        summary,
      })
    }
    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'merge',
      actionTitle: 'Merge Group',
      windowId,
      tabsProcessed: tabs.length,
      groupsBefore: allGroups.length,
      groupsAfter: (await chrome.tabGroups.query({ windowId })).length,
      createdGroupNames: [],
      summary,
      reasoning: capturedReasoning || undefined,
      reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})
  } finally {
    activeAIOperationWindows.delete(windowId)
    clearOperationTimeout(windowId)
    unregisterOperationTab(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'merge' || activeOperationsMap.get(windowId)?.type === 'group') {
      activeOperationsMap.delete(windowId)
    }
    await updateNewTabsBadge(windowId).catch(console.error)
  }
}

export async function renameDuplicateGroups(
  groupsOrClusters?: unknown,
  targetWindowId?: number,
  aiOverrides?: Partial<ExtensionSettings['ai']>
): Promise<{ renamedCount: number; results: Array<{ groupId: number; oldName: string; newName: string }> }> {
  if (!isTabGroupsSupported()) {
    throw new Error('Tab grouping is not supported in this browser.')
  }

  let windowId = targetWindowId
  if (windowId === undefined || windowId <= 0 || windowId === chrome.windows.WINDOW_ID_NONE) {
    const currentWin = await chrome.windows.getCurrent().catch(() => null)
    windowId = currentWin?.id || chrome.windows.WINDOW_ID_CURRENT
  }

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'rename', error: null })
  operationStartTimestamps.set(windowId, Date.now())

  let logger: AILogger | undefined

  try {
    const settings = await getSettings()
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured. Please enable and configure AI in Settings first.')
    }

    interface ClusterObj {
      clusterName: string
      groups: Array<{ id: number; name: string; windowId?: number }>
    }
    const clustersToProcess: ClusterObj[] = []

    if (groupsOrClusters && typeof groupsOrClusters === 'object') {
      if (Array.isArray(groupsOrClusters)) {
        if (groupsOrClusters.length > 0 && (groupsOrClusters[0] as any).groups) {
          for (const c of groupsOrClusters) {
            const cName = (c as any).originalNames?.[0] || (c as any).clusterName || (c as any).name || (c as any).groups?.[0]?.name || 'Duplicate Groups'
            clustersToProcess.push({ clusterName: cName, groups: (c as any).groups || [] })
          }
        } else if (groupsOrClusters.length > 0 && ((groupsOrClusters[0] as any).id !== undefined || (groupsOrClusters[0] as any).groupId !== undefined)) {
          const byNormalized = new Map<string, Array<{ id: number; name: string; windowId?: number }>>()
          for (const g of groupsOrClusters as any[]) {
            const gid = g.id ?? g.groupId
            const name = g.name || groupTitleMap.get(gid) || 'Group'
            const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'group'
            const list = byNormalized.get(norm) || []
            list.push({ id: gid, name, windowId: g.windowId })
            byNormalized.set(norm, list)
          }
          for (const [_, grps] of byNormalized.entries()) {
            if (grps.length > 1) {
              clustersToProcess.push({ clusterName: grps[0].name, groups: grps })
            }
          }
        }
      } else if ((groupsOrClusters as any).groups) {
        const c = groupsOrClusters as any
        const cName = c.originalNames?.[0] || c.clusterName || c.name || c.groups?.[0]?.name || 'Duplicate Groups'
        clustersToProcess.push({ clusterName: cName, groups: c.groups })
      }
    }

    if (clustersToProcess.length === 0) {
      const allChromeGroups = await chrome.tabGroups.query({})
      const byNormalized = new Map<string, Array<{ id: number; name: string; windowId: number }>>()
      for (const g of allChromeGroups) {
        const name = groupTitleMap.get(g.id) || g.title
        if (!name || name === 'Pinned' || name === '_ungrouped_') continue
        const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (!norm) continue
        const list = byNormalized.get(norm) || []
        list.push({ id: g.id, name, windowId: g.windowId })
        byNormalized.set(norm, list)
      }
      for (const [_, grps] of byNormalized.entries()) {
        if (grps.length > 1) {
          clustersToProcess.push({ clusterName: grps[0].name, groups: grps })
        }
      }
    }

    if (clustersToProcess.length === 0) {
      throw new Error('No duplicate groups found to rename.')
    }

    const validClusters: Array<{ clusterName: string; groups: DuplicateGroupClusterItem[] }> = []
    const sampleTabsForLog: Array<{ index: number; title: string; url?: string; groupId?: number }> = []
    let totalTabsToProcess = 0

    for (const cluster of clustersToProcess) {
      const clusterGroups: DuplicateGroupClusterItem[] = []
      for (const g of cluster.groups) {
        const gid = g.id
        const tabs = await chrome.tabs.query({ groupId: gid })
        if (tabs.length > 0) {
          const tabItems = tabs.map(t => ({ title: t.title || '', url: t.url || '' }))
          totalTabsToProcess += tabItems.length
          clusterGroups.push({
            groupId: gid,
            name: g.name || groupTitleMap.get(gid) || 'Group',
            tabs: tabItems,
          })
          for (const t of tabs) {
            sampleTabsForLog.push({ index: sampleTabsForLog.length + 1, title: t.title || '', url: t.url, groupId: gid })
          }
        }
      }
      if (clusterGroups.length >= 2) {
        validClusters.push({ clusterName: cluster.clusterName, groups: clusterGroups })
      }
    }

    if (validClusters.length === 0) {
      throw new Error('Duplicate groups have insufficient tabs to generate distinct names.')
    }

    await setAIBadge(windowId)

    const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
    const isShift = Boolean(aiOverrides && ((aiOverrides as any).shiftKey || (aiOverrides as any).verboseLog))
    const shouldLog = alwaysLog || isShift
    if (shouldLog) {
      logger = await AILogger.create({
        actionType: 'RENAME_DUPLICATE_GROUPS',
        triggeredWithShift: isShift,
        config: settings.ai,
        tabsInput: sampleTabsForLog,
        prompts: {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: `Generate distinct names for duplicate tab groups: ${validClusters.map(c => `"${c.clusterName}" (${c.groups.length} groups)`).join(', ')}`,
        },
        windowId,
      })
      registerTimeoutLogger(windowId, logger)
    }

    const client = new AIClient(settings.ai, controller.signal, logger)
    let capturedReasoning = ''
    const allRenamedResults: DistinctGroupRenameResult[] = []
    const affectedWindowIds = new Set<number>()
    if (windowId > 0 && windowId !== chrome.windows.WINDOW_ID_NONE) {
      affectedWindowIds.add(windowId)
    }

    let processedClusters = 0
    for (const cluster of validClusters) {
      if (controller.signal.aborted) break
      processedClusters++

      updateOperationProgress(windowId, {
        statusText: `Generating distinct names for "${cluster.clusterName}" (${processedClusters}/${validClusters.length})...`,
        batchCurrent: processedClusters,
        batchTotal: validClusters.length,
      })

      const clusterResults = await client.generateDistinctGroupNames(
        cluster.clusterName,
        cluster.groups,
        (update) => {
          if (update.liveReasoning) capturedReasoning = update.liveReasoning
          updateOperationProgress(windowId, update)
        }
      )

      for (const res of clusterResults) {
        if (controller.signal.aborted) break
        groupTitleMap.set(res.groupId, res.newName)
        const grp = await chrome.tabGroups.get(res.groupId).catch(() => null)
        if (grp) {
          affectedWindowIds.add(grp.windowId)
          const hideTitles = titlesHiddenMap.get(grp.windowId) ?? false
          await retryTabOperation(() => chrome.tabGroups.update(res.groupId, { title: hideTitles ? '' : res.newName }))
        }
        allRenamedResults.push(res)
      }
    }

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return { renamedCount: 0, results: [] }
    }

    for (const wid of affectedWindowIds) {
      invalidatePreviewCache(wid)
      await getGroupsPreview(wid)
      debouncedUpdateNewTabsBadge(wid)
    }
    activeOperationsMap.delete(windowId)

    const summary = `Renamed ${allRenamedResults.length} duplicate groups: ${allRenamedResults.map(r => `"${r.oldName}" -> "${r.newName}"`).join(', ')}`
    if (logger) {
      await logger.markCompleted({
        createdGroupsCount: allRenamedResults.length,
        createdGroupNames: allRenamedResults.map(r => r.newName),
        summary,
      })
    }

    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'rename',
      actionTitle: 'Distinct Group Renaming',
      windowId,
      tabsProcessed: totalTabsToProcess,
      createdGroupNames: allRenamedResults.map(r => r.newName),
      summary,
      reasoning: capturedReasoning || undefined,
      reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})

    return { renamedCount: allRenamedResults.length, results: allRenamedResults }
  } finally {
    activeAIOperationWindows.delete(windowId)
    clearOperationTimeout(windowId)
    unregisterOperationTab(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'rename') {
      activeOperationsMap.delete(windowId)
    }
    await updateNewTabsBadge(windowId).catch(console.error)
  }
}

export async function generateWindowName(
  targetWindowId?: number,
  aiOverrides?: Partial<ExtensionSettings['ai']> & { shiftKey?: boolean; verboseLog?: boolean }
): Promise<{ windowId: number; name: string }> {
  let windowId = targetWindowId
  if (windowId === undefined || windowId <= 0 || windowId === chrome.windows.WINDOW_ID_NONE) {
    const currentWin = await chrome.windows.getCurrent().catch(() => null)
    windowId = currentWin?.id || chrome.windows.WINDOW_ID_CURRENT
  }

  const controller = new AbortController()
  setupOperationTimeout(windowId, controller)
  activeAbortControllers.set(windowId, controller)
  activeOperationsMap.set(windowId, { type: 'name_window', error: null, statusText: 'Analyzing window tabs...' })
  operationStartTimestamps.set(windowId, Date.now())

  let logger: AILogger | undefined

  try {
    const settings = await getSettings()
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured. Please enable and configure AI in Settings first.')
    }

    const tabs = await chrome.tabs.query({ windowId })
    const sampleTabsForLog = tabs.map((t, idx) => ({
      index: idx + 1,
      title: t.title || '',
      url: t.url,
      groupId: t.groupId,
    }))

    const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
    const isShift = Boolean(aiOverrides && (aiOverrides.shiftKey || aiOverrides.verboseLog))
    const shouldLog = alwaysLog || isShift
    if (shouldLog) {
      logger = await AILogger.create({
        actionType: 'GENERATE_WINDOW_NAME',
        triggeredWithShift: isShift,
        config: { ...settings.ai, ...aiOverrides },
        tabsInput: sampleTabsForLog,
        prompts: {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: `Generate descriptive window name for window #${windowId} with ${tabs.length} tabs`,
        },
        windowId,
      })
      registerTimeoutLogger(windowId, logger)
    }

    if (tabs.length === 0) {
      const emptyName = 'Empty Window'
      if (logger) {
        await logger.markCompleted({
          createdGroupsCount: 0,
          createdGroupNames: [emptyName],
          summary: `Window #${windowId} has no tabs. Defaulted name to "${emptyName}".`,
        })
      }
      return { windowId, name: emptyName }
    }

    await setAIBadge(windowId)

    // Gather existing names of OTHER open windows to contrast with
    const namesData = await chrome.storage.local.get('customWindowNames')
    const currentCustomNames = (namesData.customWindowNames as Record<number, string>) || {}
    const existingNames = Object.entries(currentCustomNames)
      .filter(([wid]) => Number(wid) !== windowId)
      .map(([_, name]) => name)

    const mergedAIConfig = {
      ...settings.ai,
      ...aiOverrides,
    }

    const client = new AIClient(mergedAIConfig, controller.signal, logger)
    let capturedReasoning = ''

    updateOperationProgress(windowId, {
      statusText: `Generating name for window #${windowId}...`,
      totalTabs: tabs.length,
      processedTabs: tabs.length,
    })

    const generatedName = await client.generateWindowName(
      tabs.map(t => ({ url: t.url || '', title: t.title || '' })),
      {
        existingNames,
        windowId,
        customPrompt: aiOverrides?.windowNamingPrompt,
        onProgress: (update) => {
          if (update.liveReasoning) capturedReasoning = update.liveReasoning
          updateOperationProgress(windowId, update)
        },
      }
    )

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return { windowId, name: currentCustomNames[windowId] || `Window #${windowId}` }
    }

    // Persist new window name to customWindowNames
    const updatedCustomNames = { ...currentCustomNames, [windowId]: generatedName }
    await chrome.storage.local.set({ customWindowNames: updatedCustomNames })
    chrome.runtime.sendMessage({ action: 'WINDOW_NAMES_UPDATED', payload: updatedCustomNames }).catch(() => {})

    const summary = `Generated name for window: "${generatedName}"`
    if (logger) {
      await logger.markCompleted({
        createdGroupsCount: 1,
        createdGroupNames: [generatedName],
        summary,
      })
    }

    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'name_window',
      actionTitle: 'Window Naming',
      windowId,
      tabsProcessed: tabs.length,
      createdGroupNames: [generatedName],
      summary,
      reasoning: capturedReasoning || undefined,
      reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})

    return { windowId, name: generatedName }
  } catch (err: any) {
    if (logger) {
      await logger.markFailed(err)
    }
    throw err
  } finally {
    activeAIOperationWindows.delete(windowId)
    clearOperationTimeout(windowId)
    unregisterOperationTab(windowId)
    if (activeAbortControllers.get(windowId) === controller) {
      activeAbortControllers.delete(windowId)
    }
    if (activeOperationsMap.get(windowId)?.type === 'name_window') {
      activeOperationsMap.delete(windowId)
    }
    await updateNewTabsBadge(windowId).catch(console.error)
  }
}

export async function generateAllWindowsNames(
  aiOverrides?: Partial<ExtensionSettings['ai']> & { shiftKey?: boolean; verboseLog?: boolean }
): Promise<{ results: WindowNameResult[] }> {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] })
  if (!windows || windows.length === 0) {
    return { results: [] }
  }

  const focusedWin = windows.find(w => w.focused) || windows[0]
  const opWindowId = focusedWin.id || chrome.windows.WINDOW_ID_CURRENT

  const controller = new AbortController()
  setupOperationTimeout(opWindowId, controller)
  activeAbortControllers.set(opWindowId, controller)
  activeOperationsMap.set(opWindowId, { type: 'name_window', error: null, statusText: 'Analyzing all window workspaces...' })
  operationStartTimestamps.set(opWindowId, Date.now())

  let logger: AILogger | undefined

  try {
    const settings = await getSettings()
    if (!settings.ai.enabled || !settings.ai.apiKey) {
      throw new Error('AI is not configured. Please enable and configure AI in Settings first.')
    }

    const namesData = await chrome.storage.local.get('customWindowNames')
    const currentCustomNames = (namesData.customWindowNames as Record<number, string>) || {}

    const windowDataList: Array<{
      windowId: number
      tabs: Array<{ url: string; title: string }>
      currentName?: string
    }> = []

    let totalTabsCount = 0
    const sampleTabsForLog: Array<{ index: number; title: string; url?: string; groupId?: number }> = []

    for (const win of windows) {
      const wid = win.id!
      const tabs = await chrome.tabs.query({ windowId: wid })
      totalTabsCount += tabs.length
      windowDataList.push({
        windowId: wid,
        tabs: tabs.map(t => ({ url: t.url || '', title: t.title || '' })),
        currentName: currentCustomNames[wid],
      })
      for (const t of tabs) {
        sampleTabsForLog.push({ index: sampleTabsForLog.length + 1, title: t.title || '', url: t.url, groupId: t.groupId })
      }
    }

    const alwaysLog = settings.ai.alwaysLogAIOperations ?? true
    const isShift = Boolean(aiOverrides && (aiOverrides.shiftKey || aiOverrides.verboseLog))
    const shouldLog = alwaysLog || isShift
    if (shouldLog) {
      logger = await AILogger.create({
        actionType: 'GENERATE_ALL_WINDOW_NAMES',
        triggeredWithShift: isShift,
        config: { ...settings.ai, ...aiOverrides },
        tabsInput: sampleTabsForLog,
        prompts: {
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: `Generate distinct window names for ${windows.length} windows (${totalTabsCount} total tabs)`,
        },
        windowId: opWindowId,
      })
      registerTimeoutLogger(opWindowId, logger)
    }

    await setAIBadge(opWindowId)

    const mergedAIConfig = {
      ...settings.ai,
      ...aiOverrides,
    }

    const client = new AIClient(mergedAIConfig, controller.signal, logger)
    let capturedReasoning = ''

    updateOperationProgress(opWindowId, {
      statusText: `Generating distinct names for ${windows.length} windows...`,
      totalTabs: totalTabsCount,
      processedTabs: totalTabsCount,
    })

    const results = await client.generateAllWindowsNames(
      windowDataList,
      {
        customPrompt: aiOverrides?.windowNamingPrompt,
        onProgress: (update) => {
          if (update.liveReasoning) capturedReasoning = update.liveReasoning
          updateOperationProgress(opWindowId, update)
        },
      }
    )

    if (controller.signal.aborted) {
      if (logger) await logger.markFailed(new Error('Operation aborted'))
      return { results: [] }
    }

    const updatedCustomNames = { ...currentCustomNames }
    for (const res of results) {
      updatedCustomNames[res.windowId] = res.name
    }

    await chrome.storage.local.set({ customWindowNames: updatedCustomNames })
    chrome.runtime.sendMessage({ action: 'WINDOW_NAMES_UPDATED', payload: updatedCustomNames }).catch(() => {})

    const summary = `Generated names for ${results.length} windows: ${results.map(r => `[#${r.windowId}: "${r.name}"]`).join(', ')}`
    if (logger) {
      await logger.markCompleted({
        createdGroupsCount: results.length,
        createdGroupNames: results.map(r => r.name),
        summary,
      })
    }

    const lastResult: LastAIResult = {
      timestamp: Date.now(),
      actionType: 'name_window',
      actionTitle: 'Window Naming',
      windowId: opWindowId,
      tabsProcessed: totalTabsCount,
      createdGroupNames: results.map(r => r.name),
      summary,
      reasoning: capturedReasoning || undefined,
      reasoningSnippet: capturedReasoning ? (capturedReasoning.length > 120 ? '...' + capturedReasoning.slice(-120) : capturedReasoning) : undefined,
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.LAST_AI_RESULT]: lastResult })
    chrome.runtime.sendMessage({ action: 'LAST_AI_RESULT_UPDATED', payload: lastResult }).catch(() => {})

    return { results }
  } catch (err: any) {
    if (logger) {
      await logger.markFailed(err)
    }
    throw err
  } finally {
    activeAIOperationWindows.delete(opWindowId)
    clearOperationTimeout(opWindowId)
    unregisterOperationTab(opWindowId)
    if (activeAbortControllers.get(opWindowId) === controller) {
      activeAbortControllers.delete(opWindowId)
    }
    if (activeOperationsMap.get(opWindowId)?.type === 'name_window') {
      activeOperationsMap.delete(opWindowId)
    }
    await updateNewTabsBadge(opWindowId).catch(console.error)
  }
}

