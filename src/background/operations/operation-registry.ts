'use strict';

import { AILogger, setActivityCallback } from '../../shared/ai-logger'
import type { OperationStatusInfo } from '../../shared/types'

export type OperationStatus = OperationStatusInfo

const OPERATION_TIMEOUT_MS = 270_000 // 4.5 minutes

/** Tracks active AbortControllers for cancellation. Key: windowId */
export const activeAbortControllers = new Map<number, AbortController>()
export const activeTimeoutIds = new Map<number, ReturnType<typeof setTimeout>>()
export const activeTimeoutLoggers = new Map<number, AILogger | undefined>()
export const activeOperationTabIds = new Map<number, number>()
export const activeAIOperationWindows = new Set<number>()
export const activeOperationsMap = new Map<number, OperationStatus>()
export const operationStartTimestamps = new Map<number, number>()
export const timeoutEndTimestamps = new Map<number, number>()
export const autoExtendCounts = new Map<number, number>()
export const lastAutoExtendMap = new Map<number, number>()
export const applyCompletedOnCancelFlags = new Map<number, boolean>()

let isAutoExtending = false

export function registerOperationTab(windowId: number, tabId: number): void {
  activeOperationTabIds.set(windowId, tabId)
}

export function unregisterOperationTab(windowId: number): void {
  activeOperationTabIds.delete(windowId)
}

export function isAnyAIOperationRunning(): boolean {
  if (activeAIOperationWindows.size > 0) return true
  for (const op of activeOperationsMap.values()) {
    if (op && op.type !== null && op.stage !== 'completed' && op.stage !== 'failed') {
      return true
    }
  }
  for (const [, controller] of activeAbortControllers.entries()) {
    if (!controller.signal.aborted) {
      return true
    }
  }
  return false
}

export function setupOperationTimeout(windowId: number, controller: AbortController, logger?: AILogger): void {
  clearOperationTimeout(windowId)
  if (logger) {
    activeTimeoutLoggers.set(windowId, logger)
  }

  const endTs = Date.now() + OPERATION_TIMEOUT_MS
  timeoutEndTimestamps.set(windowId, endTs)

  const timeoutId = setTimeout(() => {
    const activeLogger = activeTimeoutLoggers.get(windowId)
    if (activeLogger) {
      activeLogger.logStep('TIMEOUT_ABORT', 'Operation timed out after 4.5 minutes without user extension.')
    }
    controller.abort(new Error('Operation timed out (Chrome 5-minute limit approaching). Please process fewer tabs at once or click "Extend (+5m)".'))
  }, OPERATION_TIMEOUT_MS)

  activeTimeoutIds.set(windowId, timeoutId)
}

export function registerTimeoutLogger(windowId: number, logger?: AILogger): void {
  if (logger) {
    activeTimeoutLoggers.set(windowId, logger)
  }
}

export function clearOperationTimeout(windowId: number): void {
  const existing = activeTimeoutIds.get(windowId)
  if (existing) {
    clearTimeout(existing)
    activeTimeoutIds.delete(windowId)
  }
  activeTimeoutLoggers.delete(windowId)
  timeoutEndTimestamps.delete(windowId)
  autoExtendCounts.delete(windowId)
}

export function extendOperationTimeout(windowId: number): boolean {
  const controller = activeAbortControllers.get(windowId)
  if (!controller || controller.signal.aborted) return false

  const count = (autoExtendCounts.get(windowId) ?? 0) + 1
  autoExtendCounts.set(windowId, count)

  const logger = activeTimeoutLoggers.get(windowId)
  setupOperationTimeout(windowId, controller, logger)

  if (logger) {
    logger.logStep('EXTEND_TIMEOUT', 'User extended operation timeout by an additional 4.5 minutes.')
  }

  const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
  chrome.runtime.sendMessage({
    action: 'AI_OPERATION_EXTENDED',
    payload: {
      windowId,
      remainingSeconds: Math.round(OPERATION_TIMEOUT_MS / 1000),
      endTimestamp: endTs,
      autoExtendCount: count,
    },
  }).catch(() => {})

  if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
    chrome.runtime.getPlatformInfo().catch(() => {})
  }

  return true
}

export function autoExtendOperationTimeout(windowId: number): boolean {
  if (isAutoExtending) return false

  const now = Date.now()
  const lastTime = lastAutoExtendMap.get(windowId) ?? 0
  // Throttle auto-extension to at most once every 30 seconds per window
  if (now - lastTime < 30_000) {
    return false
  }

  isAutoExtending = true
  try {
    const controller = activeAbortControllers.get(windowId)
    if (!controller || controller.signal.aborted) return false

    lastAutoExtendMap.set(windowId, now)
    const count = (autoExtendCounts.get(windowId) ?? 0) + 1
    autoExtendCounts.set(windowId, count)

    const logger = activeTimeoutLoggers.get(windowId)
    setupOperationTimeout(windowId, controller, logger)

    if (logger) {
      logger.logStepDirect('AUTO_EXTEND_TIMEOUT', `Auto-extended operation timeout by 4.5 minutes due to active AI progress (Extension #${count}).`)
    }

    const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
    chrome.runtime.sendMessage({
      action: 'AI_OPERATION_EXTENDED',
      payload: {
        windowId,
        remainingSeconds: Math.round(OPERATION_TIMEOUT_MS / 1000),
        endTimestamp: endTs,
        autoExtendCount: count,
      },
    }).catch(() => {})

    if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) {
      chrome.runtime.getPlatformInfo().catch(() => {})
    }

    return true
  } finally {
    isAutoExtending = false
  }
}

// Automatically reset operation timeout whenever AI progress activity occurs
setActivityCallback((windowId: number) => {
  autoExtendOperationTimeout(windowId)
})

export function updateOperationProgress(
  windowId: number,
  details: Partial<OperationStatusInfo>
): void {
  const current = activeOperationsMap.get(windowId)
  if (!current) return

  const startTs = operationStartTimestamps.get(windowId) ?? current.startTimestamp ?? Date.now()
  const now = Date.now()
  const elapsedMs = Math.max(0, now - startTs)

  let estimatedRemainingMs = current.estimatedRemainingMs
  const batchCurrent = details.batchCurrent ?? current.batchCurrent
  const batchTotal = details.batchTotal ?? current.batchTotal

  if (batchCurrent && batchTotal && batchTotal > 0 && batchCurrent > 1) {
    const batchesCompleted = batchCurrent - 1
    const msPerBatch = elapsedMs / batchesCompleted
    const batchesRemaining = Math.max(0, batchTotal - batchesCompleted)
    estimatedRemainingMs = Math.round(msPerBatch * batchesRemaining)
  }

  const endTs = timeoutEndTimestamps.get(windowId) ?? (now + OPERATION_TIMEOUT_MS)
  const remainingSec = Math.max(0, Math.round((endTs - now) / 1000))
  const extendCount = autoExtendCounts.get(windowId) ?? 0

  const updated: OperationStatus = {
    ...current,
    ...details,
    startTimestamp: startTs,
    elapsedMs,
    estimatedRemainingMs,
    timeoutRemainingSec: remainingSec,
    timeoutEndTimestamp: endTs,
    autoExtendCount: extendCount,
  }

  activeOperationsMap.set(windowId, updated)
  broadcastOperationProgress(windowId, updated)
}

function broadcastOperationProgress(windowId: number, status: OperationStatus): void {
  if (typeof chrome === 'undefined') return

  if (chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      action: 'AI_OPERATION_PROGRESS',
      payload: { windowId, status },
    }).catch(() => {})

    chrome.runtime.sendMessage({
      action: 'ACTIVE_OPERATIONS_UPDATED',
      payload: getActiveOperations(),
    }).catch(() => {})
  }

  if (chrome.tabs?.sendMessage) {
    const cachedTabId = activeOperationTabIds.get(windowId)
    if (cachedTabId !== undefined) {
      chrome.tabs.sendMessage(cachedTabId, {
        action: 'AI_OPERATION_PROGRESS',
        payload: { windowId, status },
      }).catch(() => {
        activeOperationTabIds.delete(windowId)
      })
    } else {
      chrome.tabs.query({ active: true, windowId }).then((tabs) => {
        const activeTab = tabs[0]
        if (activeTab?.id) {
          activeOperationTabIds.set(windowId, activeTab.id)
          chrome.tabs.sendMessage(activeTab.id, {
            action: 'AI_OPERATION_PROGRESS',
            payload: { windowId, status },
          }).catch(() => {})
        }
      }).catch(() => {})
    }
  }
}

export function setActiveOperation(
  windowId: number,
  type: 'group' | 'classify' | 'split' | 'merge' | 'sort' | 'regroup' | 'rename' | null,
  error: string | null = null
): void {
  if (type === null && error === null) {
    activeOperationsMap.delete(windowId)
    operationStartTimestamps.delete(windowId)
    activeAIOperationWindows.delete(windowId)
  } else {
    if (type !== null) {
      activeAIOperationWindows.add(windowId)
    } else {
      activeAIOperationWindows.delete(windowId)
    }
    const startTs = operationStartTimestamps.get(windowId) ?? Date.now()
    const endTs = timeoutEndTimestamps.get(windowId) ?? (Date.now() + OPERATION_TIMEOUT_MS)
    const remainingSec = Math.max(0, Math.round((endTs - Date.now()) / 1000))
    const existing = activeOperationsMap.get(windowId)
    activeOperationsMap.set(windowId, {
      ...existing,
      type,
      error,
      stage: type ? 'preparing' : 'idle',
      startTimestamp: startTs,
      timeoutRemainingSec: remainingSec,
      timeoutEndTimestamp: endTs,
      autoExtendCount: autoExtendCounts.get(windowId) ?? 0,
    })
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      action: 'ACTIVE_OPERATIONS_UPDATED',
      payload: getActiveOperations(),
    }).catch(() => {})
  }
}

export function getActiveOperations(): Record<number, OperationStatus> {
  const result: Record<number, OperationStatus> = {}
  for (const [windowId, status] of activeOperationsMap.entries()) {
    result[windowId] = status
  }
  return result
}

export function clearOperationError(windowId: number): void {
  const status = activeOperationsMap.get(windowId)
  if (status) {
    status.error = null
    if (status.type === null) {
      activeOperationsMap.delete(windowId)
    }
  }
}
