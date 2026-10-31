'use strict';

import type { AIOperationLogEntry } from './types'
import { redactSecrets } from './ai-logger'

export type LogExportFormat = 'json' | 'markdown' | 'csv'
export type LogTimeRange = 'all' | '1h' | '24h' | '7d'

export interface LogFilter {
  status?: string
  actionType?: string
  timeRange?: LogTimeRange
  search?: string
  shiftOnly?: boolean
}

export interface LogExportOptions {
  /** Include raw request/response bodies and tab lists. Defaults to false for a compact export. */
  includeRaw?: boolean
}

export interface LogTimeEstimate {
  totalMs?: number
  apiMs: number
  overheadMs?: number
  requestCount: number
  avgRequestMs?: number
  slowestRequestMs?: number
  msPerTab?: number
  /** Expected total batches, derived from tab count and configured batch size. */
  expectedBatches?: number
  /** For RUNNING logs: projected time left, based on batches completed so far. */
  estimatedRemainingMs?: number
}

const TIME_RANGE_MS: Record<Exclude<LogTimeRange, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
}

/**
 * Applies status, action, time-range and free-text filters to a list of logs.
 * @param {AIOperationLogEntry[]} logs
 * @param {LogFilter} filter
 * @param {number} [now]
 * @returns {AIOperationLogEntry[]}
 */
export function filterLogs(logs: AIOperationLogEntry[], filter: LogFilter, now = Date.now()): AIOperationLogEntry[] {
  const query = (filter.search || '').trim().toLowerCase()
  const range = filter.timeRange && filter.timeRange !== 'all' ? TIME_RANGE_MS[filter.timeRange] : 0

  return logs.filter((log) => {
    if (filter.status && filter.status !== 'all' && log.status !== filter.status) return false
    if (filter.actionType && filter.actionType !== 'all' && log.actionType !== filter.actionType) return false
    if (filter.shiftOnly && !log.triggeredWithShift) return false
    if (range && now - log.timestamp > range) return false
    if (query) {
      const haystack = [
        log.actionType,
        log.configSnapshot?.model,
        log.configSnapshot?.provider,
        log.error?.message,
        log.results?.summary,
      ].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

/**
 * Lists distinct action types present in the logs, sorted alphabetically.
 * @param {AIOperationLogEntry[]} logs
 * @returns {string[]}
 */
export function getActionTypes(logs: AIOperationLogEntry[]): string[] {
  return [...new Set(logs.map((l) => l.actionType))].sort()
}

/**
 * Derives timing metrics and a remaining-time estimate for one log.
 * @param {AIOperationLogEntry} log
 * @param {number} [now]
 * @returns {LogTimeEstimate}
 */
export function computeLogTimeEstimate(log: AIOperationLogEntry, now = Date.now()): LogTimeEstimate {
  const times = (log.rawResponses || [])
    .map((r) => r.responseTimeMs)
    .filter((t): t is number => typeof t === 'number' && t >= 0)
  const apiMs = times.reduce((sum, t) => sum + t, 0)
  const isRunning = log.status === 'RUNNING'
  const totalMs = log.durationMs ?? (isRunning ? now - log.timestamp : undefined)

  const batchSize = log.configSnapshot?.batchSize
  const expectedBatches = batchSize && batchSize > 0 && log.tabsCount > 0
    ? Math.ceil(log.tabsCount / batchSize)
    : undefined

  let estimatedRemainingMs: number | undefined
  if (isRunning && expectedBatches && times.length > 0 && totalMs !== undefined) {
    const remaining = Math.max(0, expectedBatches - times.length)
    estimatedRemainingMs = Math.round((totalMs / times.length) * remaining)
  }

  return {
    totalMs,
    apiMs,
    overheadMs: totalMs !== undefined ? Math.max(0, totalMs - apiMs) : undefined,
    requestCount: times.length,
    avgRequestMs: times.length ? Math.round(apiMs / times.length) : undefined,
    slowestRequestMs: times.length ? Math.max(...times) : undefined,
    msPerTab: totalMs !== undefined && log.tabsCount > 0 ? Math.round(totalMs / log.tabsCount) : undefined,
    expectedBatches,
    estimatedRemainingMs,
  }
}

/**
 * Formats milliseconds as a compact human string (e.g. "1m 05s", "2.4s").
 * @param {number | undefined} ms
 * @returns {string}
 */
export function formatMs(ms?: number): string {
  if (ms === undefined || isNaN(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  return `${mins}m ${String(Math.floor(secs % 60)).padStart(2, '0')}s`
}

/**
 * Returns a copy of a log with secrets scrubbed and, unless requested, bulky raw data removed.
 * @param {AIOperationLogEntry} log
 * @param {LogExportOptions} opts
 * @returns {Record<string, unknown>}
 */
function toExportShape(log: AIOperationLogEntry, opts: LogExportOptions, now: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...log,
    timeEstimate: computeLogTimeEstimate(log, now),
  }
  if (!opts.includeRaw) {
    delete base.rawRequests
    delete base.rawResponses
    delete base.tabsInput
  } else {
    base.rawRequests = log.rawRequests.map((r) => ({ ...r, endpoint: redactSecrets(r.endpoint) }))
    base.rawResponses = log.rawResponses.map((r) => ({ ...r, error: redactSecrets(r.error) }))
  }
  return base
}

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Summary statistics across a set of logs.
 * @param {AIOperationLogEntry[]} logs
 * @returns {Record<string, number>}
 */
export function summarizeLogs(logs: AIOperationLogEntry[]): { total: number; byStatus: Record<string, number>; avgDurationMs?: number; totalTabs: number } {
  const byStatus: Record<string, number> = {}
  let durationSum = 0
  let durationCount = 0
  let totalTabs = 0
  for (const log of logs) {
    byStatus[log.status] = (byStatus[log.status] || 0) + 1
    totalTabs += log.tabsCount || 0
    if (typeof log.durationMs === 'number') {
      durationSum += log.durationMs
      durationCount++
    }
  }
  return {
    total: logs.length,
    byStatus,
    avgDurationMs: durationCount ? Math.round(durationSum / durationCount) : undefined,
    totalTabs,
  }
}

/**
 * Serializes logs to the requested format, with time estimates included.
 * @param {AIOperationLogEntry[]} logs
 * @param {LogExportFormat} format
 * @param {LogExportOptions} [opts]
 * @param {number} [exportedAt]
 * @returns {string}
 */
export function formatLogsExport(
  logs: AIOperationLogEntry[],
  format: LogExportFormat,
  opts: LogExportOptions = {},
  exportedAt = Date.now()
): string {
  if (format === 'json') {
    return JSON.stringify({
      exportedAt: new Date(exportedAt).toISOString(),
      summary: summarizeLogs(logs),
      logs: logs.map((l) => toExportShape(l, opts, exportedAt)),
    }, null, 2)
  }

  if (format === 'csv') {
    const header = ['id', 'timestamp', 'actionType', 'status', 'provider', 'model', 'tabs', 'duration_ms', 'api_ms', 'overhead_ms', 'requests', 'avg_request_ms', 'ms_per_tab', 'est_cost', 'actual_cost', 'error']
    const rows = logs.map((l) => {
      const t = computeLogTimeEstimate(l, exportedAt)
      return [
        l.id, new Date(l.timestamp).toISOString(), l.actionType, l.status,
        l.configSnapshot?.provider, l.configSnapshot?.model, l.tabsCount,
        t.totalMs, t.apiMs, t.overheadMs, t.requestCount, t.avgRequestMs, t.msPerTab,
        l.tokenUsage?.estimatedCostStr, l.tokenUsage?.actualCostStr, redactSecrets(l.error?.message),
      ].map(csvCell).join(',')
    })
    return [header.join(','), ...rows].join('\n') + '\n'
  }

  const s = summarizeLogs(logs)
  const lines: string[] = [
    '# AI Operation Logs Export',
    `Exported: ${new Date(exportedAt).toISOString()} | Logs: ${s.total} | Avg duration: ${formatMs(s.avgDurationMs)}`,
    `Status: ${Object.entries(s.byStatus).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    '',
  ]
  for (const log of logs) {
    const t = computeLogTimeEstimate(log, exportedAt)
    lines.push(
      `## ${log.actionType} — ${log.status} (${new Date(log.timestamp).toISOString()})`,
      `- ID: ${log.id}`,
      `- Model: ${log.configSnapshot?.provider ?? '?'} / ${log.configSnapshot?.model ?? 'default'}`,
      `- Tabs: ${log.tabsCount}${t.expectedBatches ? ` (~${t.expectedBatches} batches)` : ''}`,
      `- Time: total ${formatMs(t.totalMs)}, API ${formatMs(t.apiMs)}, overhead ${formatMs(t.overheadMs)}`,
      `- Requests: ${t.requestCount} (avg ${formatMs(t.avgRequestMs)}, slowest ${formatMs(t.slowestRequestMs)}, ${formatMs(t.msPerTab)}/tab)`,
    )
    if (t.estimatedRemainingMs !== undefined) lines.push(`- Estimated remaining: ${formatMs(t.estimatedRemainingMs)}`)
    if (log.tokenUsage?.estimatedCostStr || log.tokenUsage?.actualCostStr) {
      lines.push(`- Cost: est ${log.tokenUsage?.estimatedCostStr ?? '—'}, actual ${log.tokenUsage?.actualCostStr ?? '—'}`)
    }
    if (log.results?.summary) lines.push(`- Result: ${log.results.summary}`)
    if (log.error) lines.push(`- Error: ${redactSecrets(log.error.message)}`)
    lines.push('', '### Steps')
    for (const step of log.steps) {
      lines.push(`- \`${new Date(step.timestamp).toISOString()}\` **${step.step}** ${step.detail}`)
    }
    if (opts.includeRaw) {
      lines.push('', '### Tabs')
      for (const tab of log.tabsInput) lines.push(`- ${tab.title}${tab.url ? ` — ${tab.url}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Builds a filename for a log export.
 * @param {LogExportFormat} format
 * @param {AIOperationLogEntry[]} logs
 * @param {number} [now]
 * @returns {string}
 */
export function buildLogExportFilename(format: LogExportFormat, logs: AIOperationLogEntry[], now = Date.now()): string {
  const ext = format === 'markdown' ? 'md' : format
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const label = logs.length === 1 ? logs[0].actionType.toLowerCase() : 'logs'
  return `ai_${label}_${stamp}.${ext}`
}
