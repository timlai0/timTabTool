'use strict';

import type { AIOperationLogEntry, AIConfig } from './types'
import { STORAGE_KEYS } from './constants'

const MAX_LOG_ENTRIES = 50

/**
 * @callback ActivityCallback
 * @param {number} windowId
 */
export type ActivityCallback = (windowId: number) => void
let globalActivityCallback: ActivityCallback | null = null

/**
 * Sets the global activity callback.
 * @param {ActivityCallback | null} cb - Callback to run on activity.
 */
export function setActivityCallback(cb: ActivityCallback | null): void {
  globalActivityCallback = cb
}

/**
 * @class AILogger
 * Logger for AI operations, persisting to local storage.
 */
export class AILogger {
  /** @property {AIOperationLogEntry} entry - The log entry being managed */
  private entry: AIOperationLogEntry

  private constructor(entry: AIOperationLogEntry) {
    this.entry = entry
  }

  /**
   * Initialize a new log entry and immediately persist it to storage so it is retained even if a crash happens.
   */
  static async create(params: {
    actionType: string
    triggeredWithShift: boolean
    config: AIConfig
    tabsInput?: Array<{ index: number; title: string; url?: string; groupId?: number; groupTitle?: string }>
    prompts?: { systemPrompt?: string; userPrompt?: string; customPrompt?: string; coherencePrompt?: string }
    windowId?: number
  }): Promise<AILogger> {
    const id = `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    
    // Mask sensitive API keys
    const maskedConfig = {
      provider: params.config.provider || 'openai',
      model: params.config.model,
      endpoint: params.config.endpoint,
      sendFullUrl: params.config.sendFullUrl,
      batchSize: params.config.batchSize,
      maxTokens: params.config.maxTokens,
      maxRetries: params.config.maxRetries,
      bypassSafeguards: params.config.bypassSafeguards,
    }

    const entry: AIOperationLogEntry = {
      id,
      timestamp: Date.now(),
      actionType: params.actionType,
      triggeredWithShift: params.triggeredWithShift,
      status: 'RUNNING',
      windowId: params.windowId,
      tabsCount: params.tabsInput?.length ?? 0,
      configSnapshot: maskedConfig,
      tabsInput: params.tabsInput ?? [],
      prompts: params.prompts ?? {},
      steps: [
        {
          timestamp: Date.now(),
          step: 'INIT',
          detail: `AI Operation [${params.actionType}] initialized. (Shift-clicked: ${params.triggeredWithShift})`,
        },
      ],
      rawRequests: [],
      rawResponses: [],
    }

    const logger = new AILogger(entry)
    await logger.flush()
    return logger
  }

  /**
   * Gets the ID of the current log entry.
   * @returns {string}
   */
  get entryId(): string {
    // Logic: Return internal ID
    return this.entry.id
  }

  /**
   * @returns {boolean} Whether operation was shift-triggered.
   */
  get isShift(): boolean {
    return this.entry.triggeredWithShift
  }

  /**
   * Notify activity callback.
   */
  touchActivity(): void {
    // Logic: Ping the global callback to indicate UI activity
    if (this.entry.windowId !== undefined && globalActivityCallback) {
      globalActivityCallback(this.entry.windowId)
    }
  }

  /**
   * Logs a step without triggering activity.
   * @param {string} step
   * @param {string} detail
   * @param {Record<string, unknown>} [metadata]
   */
  logStepDirect(step: string, detail: string, metadata?: Record<string, unknown>): void {
    this.entry.steps.push({
      timestamp: Date.now(),
      step,
      detail,
      metadata,
    })
    this.flush()
  }

  /**
   * Logs a step and triggers activity.
   * @param {string} step
   * @param {string} detail
   * @param {Record<string, unknown>} [metadata]
   */
  logStep(step: string, detail: string, metadata?: Record<string, unknown>): void {
    this.entry.steps.push({
      timestamp: Date.now(),
      step,
      detail,
      metadata,
    })
    this.flush()
    this.touchActivity()
  }

  /**
   * Logs a raw AI API request.
   */
  logRawRequest(
    batchIndex: number,
    endpoint: string,
    payloadSummary: string,
    systemMessage?: string,
    userMessage?: string
  ): void {
    this.entry.rawRequests.push({
      batchIndex,
      endpoint,
      payloadSummary,
      systemMessage,
      userMessage,
      requestTimestamp: Date.now(),
    })
    this.flush()
    this.touchActivity()
  }

  /**
   * Logs a raw AI API response.
   */
  logRawResponse(
    batchIndex: number,
    statusCode?: number,
    responseTimeMs?: number,
    responseBody?: string,
    parsedJson?: unknown,
    error?: string
  ): void {
    this.entry.rawResponses.push({
      batchIndex,
      statusCode,
      responseTimeMs,
      responseBody,
      parsedJson,
      error,
      responseTimestamp: Date.now(),
    })
    this.flush()
    this.touchActivity()
  }

  /**
   * Records token usage estimation.
   */
  recordTokenEstimate(estimatedInputTokens?: number, estimatedOutputTokens?: number, estimatedCostStr?: string): void {
    this.entry.tokenUsage = {
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostStr,
    }
    this.flush()
  }

  async markCompleted(results?: {
    createdGroupsCount?: number
    createdGroupNames?: string[]
    groupsBefore?: number
    groupsAfter?: number
    summary?: string
  }): Promise<void> {
    this.entry.endTime = Date.now()
    this.entry.durationMs = this.entry.endTime - this.entry.timestamp
    this.entry.status = 'COMPLETED'
    this.entry.results = results
    this.entry.steps.push({
      timestamp: Date.now(),
      step: 'COMPLETED',
      detail: `AI Operation completed successfully in ${this.entry.durationMs}ms.`,
    })
    await this.flush()
  }

  async markFailed(err: unknown, failedBatchIndex?: number): Promise<void> {
    const errorObj = err instanceof Error ? err : new Error(String(err))
    this.entry.endTime = Date.now()
    this.entry.durationMs = this.entry.endTime - this.entry.timestamp
    this.entry.status = 'FAILED'
    this.entry.error = {
      message: errorObj.message || 'Unknown operation error',
      name: errorObj.name,
      stack: errorObj.stack,
      failedBatchIndex,
    }
    this.entry.steps.push({
      timestamp: Date.now(),
      step: 'ERROR',
      detail: `AI Operation failed: ${errorObj.message}`,
      metadata: { stack: errorObj.stack },
    })
    await this.flush()
  }

  /**
   * Persist current entry state to chrome.storage.local immediately.
   */
  private async flush(): Promise<void> {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return

      const data = await chrome.storage.local.get(STORAGE_KEYS.AI_OPERATION_LOGS)
      const existingLogs: AIOperationLogEntry[] = (data[STORAGE_KEYS.AI_OPERATION_LOGS] as AIOperationLogEntry[]) || []

      const index = existingLogs.findIndex(l => l.id === this.entry.id)
      if (index >= 0) {
        existingLogs[index] = { ...this.entry }
      } else {
        existingLogs.unshift({ ...this.entry })
      }

      // Cap logs length to MAX_LOG_ENTRIES
      if (existingLogs.length > MAX_LOG_ENTRIES) {
        existingLogs.length = MAX_LOG_ENTRIES
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.AI_OPERATION_LOGS]: existingLogs })
    } catch (err) {
      console.error('[AILogger] Storage flush failed:', err)
    }
  }

  /**
   * Automatically resolve any running logs that were interrupted by a crash or service worker restart.
   */
  static async cleanOrphanedRunningLogs(activeWindowIds?: Set<number>): Promise<AIOperationLogEntry[]> {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return []
    const data = await chrome.storage.local.get(STORAGE_KEYS.AI_OPERATION_LOGS)
    const logs: AIOperationLogEntry[] = (data[STORAGE_KEYS.AI_OPERATION_LOGS] as AIOperationLogEntry[]) || []
    let updated = false

    const now = Date.now()
    for (const log of logs) {
      if (log.status === 'RUNNING') {
        const isStale = (now - log.timestamp > 240_000) // Older than 4 minutes
        const isNotActiveInWindow = activeWindowIds && log.windowId !== undefined && !activeWindowIds.has(log.windowId)
        
        if (isStale || isNotActiveInWindow || activeWindowIds === undefined) {
          log.status = 'CRASHED'
          log.endTime = now
          log.durationMs = now - log.timestamp
          log.error = {
            message: 'Operation interrupted (Browser, tab, or extension crashed during execution).',
            name: 'InterruptedException',
          }
          log.steps.push({
            timestamp: now,
            step: 'CRASHED',
            detail: 'Operation interrupted due to extension or browser crash.',
          })
          updated = true
        }
      }
    }

    if (updated) {
      await chrome.storage.local.set({ [STORAGE_KEYS.AI_OPERATION_LOGS]: logs })
    }

    return logs
  }

  /**
   * Retrieve all saved AI operation logs from local storage.
   */
  static async getLogs(): Promise<AIOperationLogEntry[]> {
    return AILogger.cleanOrphanedRunningLogs()
  }

  /**
   * Clear all AI operation logs.
   */
  static async clearLogs(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return
    await chrome.storage.local.remove(STORAGE_KEYS.AI_OPERATION_LOGS)
  }

  /**
   * Delete a specific log by ID.
   */
  static async deleteLog(id: string): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return
    const logs = await AILogger.getLogs()
    const filtered = logs.filter(l => l.id !== id)
    await chrome.storage.local.set({ [STORAGE_KEYS.AI_OPERATION_LOGS]: filtered })
  }
}
