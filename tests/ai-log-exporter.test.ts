import { describe, it, expect } from 'vitest'
import {
  filterLogs, computeLogTimeEstimate, formatLogsExport, getActionTypes, formatMs, buildLogExportFilename,
} from '../src/shared/ai-log-exporter'
import type { AIOperationLogEntry } from '../src/shared/types'

const NOW = 1_700_000_000_000

function makeLog(over: Partial<AIOperationLogEntry> = {}): AIOperationLogEntry {
  return {
    id: 'log_1',
    timestamp: NOW - 60_000,
    actionType: 'GROUP_TABS',
    triggeredWithShift: false,
    status: 'COMPLETED',
    tabsCount: 40,
    configSnapshot: { provider: 'openai', model: 'gpt-4o-mini', batchSize: 20 },
    tabsInput: [{ index: 0, title: 'A', url: 'https://a.com' }],
    prompts: {},
    steps: [{ timestamp: NOW - 59_000, step: 'INIT', detail: 'started' }],
    rawRequests: [{ batchIndex: 0, endpoint: 'https://x/api?key=SECRET123', payloadSummary: '', requestTimestamp: NOW }],
    rawResponses: [
      { batchIndex: 0, responseTimeMs: 2000, responseTimestamp: NOW },
      { batchIndex: 1, responseTimeMs: 4000, responseTimestamp: NOW },
    ],
    durationMs: 10_000,
    ...over,
  }
}

describe('filterLogs', () => {
  const logs = [
    makeLog({ id: 'a' }),
    makeLog({ id: 'b', status: 'FAILED', actionType: 'SPLIT_GROUP', error: { message: 'rate limit hit' } }),
    makeLog({ id: 'c', timestamp: NOW - 3 * 86_400_000, triggeredWithShift: true }),
  ]

  it('filters by status, action, time range, shift and search', () => {
    expect(filterLogs(logs, { status: 'FAILED' }, NOW).map(l => l.id)).toEqual(['b'])
    expect(filterLogs(logs, { actionType: 'GROUP_TABS' }, NOW).map(l => l.id)).toEqual(['a', 'c'])
    expect(filterLogs(logs, { timeRange: '24h' }, NOW).map(l => l.id)).toEqual(['a', 'b'])
    expect(filterLogs(logs, { shiftOnly: true }, NOW).map(l => l.id)).toEqual(['c'])
    expect(filterLogs(logs, { search: 'RATE' }, NOW).map(l => l.id)).toEqual(['b'])
    expect(filterLogs(logs, { status: 'all', actionType: 'all' }, NOW)).toHaveLength(3)
  })

  it('lists distinct action types', () => {
    expect(getActionTypes(logs)).toEqual(['GROUP_TABS', 'SPLIT_GROUP'])
  })
})

describe('computeLogTimeEstimate', () => {
  it('derives API vs overhead time and per-tab cost', () => {
    const t = computeLogTimeEstimate(makeLog(), NOW)
    expect(t.apiMs).toBe(6000)
    expect(t.overheadMs).toBe(4000)
    expect(t.avgRequestMs).toBe(3000)
    expect(t.slowestRequestMs).toBe(4000)
    expect(t.msPerTab).toBe(250)
    expect(t.expectedBatches).toBe(2)
  })

  it('projects remaining time for running logs', () => {
    const log = makeLog({
      status: 'RUNNING', durationMs: undefined, tabsCount: 60, timestamp: NOW - 10_000,
      rawResponses: [{ batchIndex: 0, responseTimeMs: 5000, responseTimestamp: NOW }],
    })
    const t = computeLogTimeEstimate(log, NOW)
    expect(t.totalMs).toBe(10_000)
    expect(t.expectedBatches).toBe(3)
    expect(t.estimatedRemainingMs).toBe(20_000)
  })

  it('handles logs without responses', () => {
    const t = computeLogTimeEstimate(makeLog({ rawResponses: [], durationMs: undefined }), NOW)
    expect(t.requestCount).toBe(0)
    expect(t.avgRequestMs).toBeUndefined()
  })
})

describe('formatLogsExport', () => {
  it('json omits raw data by default and redacts when included', () => {
    const compact = JSON.parse(formatLogsExport([makeLog()], 'json', {}, NOW))
    expect(compact.logs[0].rawRequests).toBeUndefined()
    expect(compact.logs[0].timeEstimate.apiMs).toBe(6000)
    expect(compact.summary.total).toBe(1)

    const full = formatLogsExport([makeLog()], 'json', { includeRaw: true }, NOW)
    expect(full).not.toContain('SECRET123')
    expect(full).toContain('[REDACTED]')
  })

  it('csv escapes cells and has one row per log', () => {
    const csv = formatLogsExport([makeLog({ error: { message: 'bad, "quoted"' } })], 'csv', {}, NOW)
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('"bad, ""quoted"""')
  })

  it('markdown includes timing summary', () => {
    const md = formatLogsExport([makeLog()], 'markdown', {}, NOW)
    expect(md).toContain('## GROUP_TABS — COMPLETED')
    expect(md).toContain('API 6.0s')
  })
})

describe('helpers', () => {
  it('formats durations and filenames', () => {
    expect(formatMs(450)).toBe('450ms')
    expect(formatMs(65_000)).toBe('1m 05s')
    expect(formatMs(undefined)).toBe('—')
    expect(buildLogExportFilename('markdown', [makeLog()], NOW)).toMatch(/^ai_group_tabs_.*\.md$/)
    expect(buildLogExportFilename('csv', [makeLog(), makeLog()], NOW)).toMatch(/^ai_logs_.*\.csv$/)
  })
})
