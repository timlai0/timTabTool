'use strict';

import { normalizeUrl } from './url-utils'
import { isRestorableUrl } from './closed-tabs-manager'

export type TabExportScope = 'all_unclosed' | 'open_only' | 'missing_only'
export type TabExportFormat = 'markdown' | 'json' | 'txt' | 'html'

export interface ExportableOpenTab {
  id?: number
  url: string
  title: string
  favIconUrl?: string
  windowId?: number
  windowName?: string
  groupId?: number
  groupTitle?: string
  groupColor?: string
  pinned?: boolean
  active?: boolean
  lastAccessed?: number
}

export interface ExportableHistoryTab {
  url: string
  title: string
  favIconUrl?: string
  lastAccessed: number
  visitCount?: number
  closed?: boolean
  windowId?: number
  windowName?: string
  groupTitle?: string
}

export interface ExportedTabItem {
  url: string
  title: string
  status: 'open' | 'unrestored'
  windowId?: number
  windowName?: string
  groupTitle?: string
  pinned?: boolean
  lastAccessed?: number
  visitCount?: number
  favIconUrl?: string
}

export interface BuildKnownUnclosedTabsParams {
  openTabs: ExportableOpenTab[]
  historyEntries: ExportableHistoryTab[]
  explicitlyClosedUrls: Iterable<string>
  scope: TabExportScope
}

/**
 * Normalizes a URL for set membership comparison.
 * @param {string | undefined} url
 * @returns {string}
 */
function getUrlKey(url?: string): string {
  if (!url) return ''
  return normalizeUrl(url) || url.trim()
}

/**
 * Escapes HTML special characters for safe bookmark/HTML generation.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Collects open tabs that have valid restorable URLs.
 * @param {ExportableOpenTab[]} openTabs
 * @param {Set<string>} openUrlKeys
 * @returns {ExportedTabItem[]}
 */
function collectOpenExportItems(openTabs: ExportableOpenTab[], openUrlKeys: Set<string>): ExportedTabItem[] {
  const result: ExportedTabItem[] = []
  let tab: ExportableOpenTab
  for (tab of openTabs) {
    if (!isRestorableUrl(tab.url)) continue
    const key = getUrlKey(tab.url)
    if (key) openUrlKeys.add(key)
    result.push({
      url: tab.url,
      title: tab.title || tab.url,
      status: 'open',
      windowId: tab.windowId,
      windowName: tab.windowName,
      groupTitle: tab.groupTitle || (tab.pinned ? 'Pinned' : undefined),
      pinned: Boolean(tab.pinned),
      lastAccessed: tab.lastAccessed,
      favIconUrl: tab.favIconUrl,
    })
  }
  return result
}

/**
 * Collects history tabs that are not currently open and were not explicitly closed.
 * @param {ExportableHistoryTab[]} historyEntries
 * @param {Set<string>} openUrlKeys
 * @param {Set<string>} closedUrlKeys
 * @returns {ExportedTabItem[]}
 */
function collectUnrestoredHistoryItems(
  historyEntries: ExportableHistoryTab[],
  openUrlKeys: Set<string>,
  closedUrlKeys: Set<string>
): ExportedTabItem[] {
  const seenKeys = new Set<string>()
  const sortedHistory = [...historyEntries].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
  const result: ExportedTabItem[] = []
  let entry: ExportableHistoryTab

  for (entry of sortedHistory) {
    if (entry.closed) continue
    if (!isRestorableUrl(entry.url)) continue
    const key = getUrlKey(entry.url)
    if (!key || openUrlKeys.has(key) || closedUrlKeys.has(key) || seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    result.push({
      url: entry.url,
      title: entry.title || entry.url,
      status: 'unrestored',
      windowId: entry.windowId,
      windowName: entry.windowName,
      groupTitle: entry.groupTitle,
      lastAccessed: entry.lastAccessed,
      visitCount: entry.visitCount,
      favIconUrl: entry.favIconUrl,
    })
  }
  return result
}

/**
 * Builds the filtered list of known non-closed tabs according to the selected export scope.
 * @param {BuildKnownUnclosedTabsParams} params
 * @returns {ExportedTabItem[]}
 */
export function buildKnownUnclosedTabs(params: BuildKnownUnclosedTabsParams): ExportedTabItem[] {
  const openUrlKeys = new Set<string>()
  const closedUrlKeys = new Set<string>()
  let rawClosedUrl: string

  for (rawClosedUrl of params.explicitlyClosedUrls) {
    const key = getUrlKey(rawClosedUrl)
    if (key) closedUrlKeys.add(key)
  }

  const openItems = collectOpenExportItems(params.openTabs, openUrlKeys)
  if (params.scope === 'open_only') {
    return openItems
  }

  const missingItems = collectUnrestoredHistoryItems(params.historyEntries, openUrlKeys, closedUrlKeys)
  if (params.scope === 'missing_only') {
    return missingItems
  }

  return [...openItems, ...missingItems]
}

/**
 * Groups open tab items by window label and group title.
 * @param {ExportedTabItem[]} openItems
 * @returns {Map<string, Map<string, ExportedTabItem[]>>}
 */
function groupOpenItemsByWindowAndGroup(openItems: ExportedTabItem[]): Map<string, Map<string, ExportedTabItem[]>> {
  const byWindow = new Map<string, Map<string, ExportedTabItem[]>>()
  let item: ExportedTabItem

  for (item of openItems) {
    const winLabel = item.windowName || (item.windowId ? `Window #${item.windowId}` : 'Current Window')
    const grpLabel = item.groupTitle || 'Ungrouped'
    let groupMap = byWindow.get(winLabel)
    if (!groupMap) {
      groupMap = new Map<string, ExportedTabItem[]>()
      byWindow.set(winLabel, groupMap)
    }
    const list = groupMap.get(grpLabel) || []
    list.push(item)
    groupMap.set(grpLabel, list)
  }
  return byWindow
}

/**
 * Formats exported tabs as Markdown grouped by status, window, and tab group.
 * @param {ExportedTabItem[]} items
 * @param {TabExportScope} scope
 * @param {number} [exportedAt]
 * @returns {string}
 */
export function formatExportAsMarkdown(
  items: ExportedTabItem[],
  scope: TabExportScope,
  exportedAt = Date.now()
): string {
  const isoDate = new Date(exportedAt).toISOString()
  const lines: string[] = [
    '# Known Unclosed Tabs Export',
    `Exported: ${isoDate} | Scope: ${scope} | Total: ${items.length} tabs`,
    '',
  ]

  if (items.length === 0) {
    lines.push('_No matching tabs found._')
    return lines.join('\n')
  }

  const openItems = items.filter((i) => i.status === 'open')
  const missingItems = items.filter((i) => i.status === 'unrestored')

  if (openItems.length > 0) {
    lines.push(`## Currently Open Tabs (${openItems.length})`, '')
    const byWindow = groupOpenItemsByWindowAndGroup(openItems)
    for (const [winLabel, groupMap] of byWindow.entries()) {
      lines.push(`### ${winLabel}`)
      for (const [grpLabel, tabList] of groupMap.entries()) {
        lines.push(`#### ${grpLabel} (${tabList.length})`)
        for (const tab of tabList) {
          lines.push(`- [${tab.title}](${tab.url})`)
        }
        lines.push('')
      }
    }
  }

  if (missingItems.length > 0) {
    lines.push(`## Unrestored / Known Unclosed History Tabs (${missingItems.length})`, '')
    for (const tab of missingItems) {
      const lastSeen = tab.lastAccessed ? ` _(Last seen: ${new Date(tab.lastAccessed).toISOString()})_` : ''
      lines.push(`- [${tab.title}](${tab.url})${lastSeen}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Formats exported tabs as structured JSON.
 * @param {ExportedTabItem[]} items
 * @param {TabExportScope} scope
 * @param {number} [exportedAt]
 * @returns {string}
 */
export function formatExportAsJson(
  items: ExportedTabItem[],
  scope: TabExportScope,
  exportedAt = Date.now()
): string {
  const openCount = items.filter((i) => i.status === 'open').length
  const unrestoredCount = items.filter((i) => i.status === 'unrestored').length
  const payload = {
    exportedAt: new Date(exportedAt).toISOString(),
    timestamp: exportedAt,
    scope,
    counts: {
      total: items.length,
      open: openCount,
      unrestored: unrestoredCount,
    },
    tabs: items,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Formats exported tabs as a plain text URL list (one URL per line).
 * @param {ExportedTabItem[]} items
 * @returns {string}
 */
export function formatExportAsPlainText(items: ExportedTabItem[]): string {
  if (items.length === 0) return ''
  return items.map((i) => i.url).join('\n') + '\n'
}

/**
 * Formats exported tabs as a Netscape Bookmark HTML file importable by browsers.
 * @param {ExportedTabItem[]} items
 * @param {TabExportScope} scope
 * @param {number} [exportedAt]
 * @returns {string}
 */
export function formatExportAsHtmlBookmarks(
  items: ExportedTabItem[],
  scope: TabExportScope,
  exportedAt = Date.now()
): string {
  const nowSec = Math.floor(exportedAt / 1000)
  const dateLabel = new Date(exportedAt).toISOString().slice(0, 10)
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    `  <DT><H3 ADD_DATE="${nowSec}" LAST_MODIFIED="${nowSec}">timTabTool Export (${escapeHtml(dateLabel)} - ${escapeHtml(scope)})</H3>`,
    '  <DL><p>',
  ]

  const openItems = items.filter((i) => i.status === 'open')
  const missingItems = items.filter((i) => i.status === 'unrestored')

  if (openItems.length > 0) {
    const byWindow = groupOpenItemsByWindowAndGroup(openItems)
    for (const [winLabel, groupMap] of byWindow.entries()) {
      lines.push(`    <DT><H3 ADD_DATE="${nowSec}">${escapeHtml(winLabel)}</H3>`, '    <DL><p>')
      for (const [grpLabel, tabList] of groupMap.entries()) {
        lines.push(`      <DT><H3 ADD_DATE="${nowSec}">${escapeHtml(grpLabel)}</H3>`, '      <DL><p>')
        for (const tab of tabList) {
          const addDate = tab.lastAccessed ? Math.floor(tab.lastAccessed / 1000) : nowSec
          lines.push(`        <DT><A HREF="${escapeHtml(tab.url)}" ADD_DATE="${addDate}">${escapeHtml(tab.title)}</A>`)
        }
        lines.push('      </DL><p>')
      }
      lines.push('    </DL><p>')
    }
  }

  if (missingItems.length > 0) {
    lines.push(`    <DT><H3 ADD_DATE="${nowSec}">Unrestored History Tabs (${missingItems.length})</H3>`, '    <DL><p>')
    for (const tab of missingItems) {
      const addDate = tab.lastAccessed ? Math.floor(tab.lastAccessed / 1000) : nowSec
      lines.push(`      <DT><A HREF="${escapeHtml(tab.url)}" ADD_DATE="${addDate}">${escapeHtml(tab.title)}</A>`)
    }
    lines.push('    </DL><p>')
  }

  lines.push('  </DL><p>', '</DL><p>')
  return lines.join('\n')
}

/**
 * Formats exported tabs into the specified output format.
 * @param {ExportedTabItem[]} items
 * @param {TabExportFormat} format
 * @param {TabExportScope} scope
 * @param {number} [exportedAt]
 * @returns {string}
 */
export function formatKnownUnclosedTabs(
  items: ExportedTabItem[],
  format: TabExportFormat,
  scope: TabExportScope,
  exportedAt = Date.now()
): string {
  switch (format) {
    case 'markdown':
      return formatExportAsMarkdown(items, scope, exportedAt)
    case 'json':
      return formatExportAsJson(items, scope, exportedAt)
    case 'txt':
      return formatExportAsPlainText(items)
    case 'html':
      return formatExportAsHtmlBookmarks(items, scope, exportedAt)
  }
}
